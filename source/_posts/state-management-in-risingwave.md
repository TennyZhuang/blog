---
title: RisingWave 中的状态管理
date: 2022-04-30 15:40:38
tags:
- Programming
- Streaming System
- RisingWave
---

![RisingWave](https://github.com/singularity-data/risingwave/raw/main/docs/images/logo-title.svg)

[RisingWave](https://github.com/singularity-data/risingwave) 是近期开源的一款 Rust 写的云原生流数据库产品。今天根据下图简单介绍一下 RisingWave 中的状态管理机制：

![RisingWave StateStore](https://user-images.githubusercontent.com/9161438/166138021-c7077f83-6144-4297-a42c-059954931df4.png)

<!-- more -->

## Hummock Overview

在 RisingWave 的架构中，所有内部状态和物化视图的存储都是基于一套名为 Hummock 的存储来实现的。Hummock 并不是一个 storage system，而是一个 storage library。Hummock 目前支持兼容 S3 协议的存储服务作为其后端。

从接口上，Hummock 提供了类似 Key-Value store 的接口：

- get(key, epoch)：获取一个 value
- iter(range, epoch)：扫描一个范围的 key-value pairs
- batch_ingest(key-value batch)：插入一批 key-value pairs

可以看到，与一般的 key-value store 接口不同，Hummock 没有提供正常的 put 接口，而是只提供了 batch 的输入接口。同时所有的操作都带了 epoch 的参数。这与 RisingWave 基于 epoch 的状态管理机制有关。

## Epoch-based checkpoint

RisingWave 是一个基于固定 epoch 的 partial synchronized system。每隔一个固定的时间，中心的 meta 节点会产生一个 epoch，并会向整个 DAG 的所有 source 节点发起 `InjectBarrier` 请求。source 节点收到 barrier 后，将其注入到当前数据流的一个切片。

![epoch](https://user-images.githubusercontent.com/9161438/166149113-984b14d5-75b6-4ead-94aa-aa63df14a21a.png)

```proto
message Barrier {
  Epoch epoch = 1;
  oneof mutation {
    NothingMutation nothing = 2;
    StopMutation stop = 3;
    UpdateMutation update = 4;
    AddMutation add = 5;
  }
}
```

对于 DAG 中间的任何一个算子，如果收到了一个 barrier，需要依次做一些事情：

1. 如果是一个多输入流的算子（Join、Union)，那么需要等待其它流的 barrier，直到收集齐所有输入流的同一个 barrier 以后才处理。
2. 如果有需要操作的 mutation（用于 scale-out，create mview，drop mview），那么 apply 对应的 conf change。
3. **dump local state (async checkpoint)**

3 是本文想介绍的重点。简单来说，**RisingWave 既不是一个 local state backend，也不是 remote state backend，而是一个混合形态**。只有最新的 barrier 之后的 state 才是算子自身维护的 local state，而之前的数据则是 remote state。当且仅当收到 barrier 的时候，算子才会选择 dump 状态到 hummock store。这也就是 hummock store 只提供 ingest batch 接口的原因 ———— 算子只会在收到 barrier 的时候将 local state dump 到 hummock 中去。

## Async Checkpoint

前文中我们提到，算子在收到 barrier 时，会选择 dump 数据到 Hummock，但我们也提到了 barrier 是随着数据流一起流动的，如果每个算子都需要同步地将等待状态被上传到 shared storage（目前是 S3），那么数据处理就会 blocking 一整个上传的 Round trip。如果 DAG 中有 N 个有状态算子的话，那么 barrier 在整个传递过程中就会被 delay N 个 round trip，这对整个系统的处理能力会产生很大的影响。因此，我们将 barrier 的处理流程几乎全异步化了。有状态算子在收到 barrier 后需要做的唯一一件事，就是将当前 epoch 的 local state 同步地 `std::mem::take` 走，重置为一个空的 state，让算子可以接着处理下一个 epoch 的数据。这也引入了一系列的问题：

- 这个 epoch 的 local state 被 take 到哪里去了？
- 既然 local state 并没有同步地上传到 S3，那么针对这段时间数据的查询应该怎么处理呢？
- 在异步上传的时候，算子 crash 了怎么办，如何知道 checkpoint 是否成功？

为了解答上面的这些问题，我们引入了 Shared Buffer。

## Shared Buffer

Shared Buffer 是一个 Compute Node 的所有算子共享的一个后台任务，当有状态算子收到 barrier 之后，local state 会被 take 到 Shared Buffer 里。

Shared Buffer 主要负责以下事情：

1. （可选）部分算子的状态可能会很小，如 SimpleAgg。根据 local state 的大小，适当地在不同算子的 state 在文件粒度上之间做切分和合并。
2. 将算子本地的状态上传到 shared storage 上。
3. **向 meta service 注册已经成功上传成功的 state 记录。**
4. **服务来自算子内部对尚未上传成功的 local state 的查询。**

这里的 3 和 4 很好地回答了上一小节提的问题。

- 从用户的视角，只有一个 epoch 内所有算子的 local state 全部上传完成**并在 meta service 注册成功**，才认为这个 checkpoint 是完成的，无论是正常 query 还是 recover，都会基于**最新的完整 checkpoint**。
- 从内部算子的视角，在读自己 state 的时候，必然是要求读到完整最新状态的，那么事实上内部算子需要的是 remote state + shared buffer + local state merge 后的结果。这里 RisingWave 也提供了 `MergeIterator` 来做这个泛化。

## Local Cache

由于大部分状态在 remote state 中，RisingWave 可以很简单地实现 scale-out，然而带来的代价也是很明显的。相比于 Flink 这种 local state 的设计，RisingWave 需要多很多 remote lookup。

我们以 HashAgg 为例，当 HashAgg 算子收到 Barrier 后，它会把当前 barrier 的统计结果 dump 到 shared buffer，将算子本地的 state 重置为空。然而在处理下一个 epoch 数据的时候，最近处理过的 group key 很可能依然就是热点，我们不得不重新从 shared buffer 甚至 remote state 重新将对应的 key 捞回来。因此我们的选择是，在算子内部不再将之前 epoch 的 local state 重置清空，而是将其标记为 evictable，当且仅当内存不足时，再清理 evictable 的数据记录。

基于这个设计，在内存充足的情况下，或者对于状态非常小的算子（如 simple agg 仅有一条记录），它的所有状态都在内存里，且都由当前线程去操作，达到了最大化的性能，而 dump 仅用于 recovery 和 query。对于内存不足的情况下，或者对于有明显冷热特征的算子（如 TopN），那么既能保证正确运行（冷数据去 remote lookup），又能充分榨干每一分内存，

## Compaction

State 并不是上传到 shared storage 就不再修改了，RisingWave 会有后台的 compaction 任务。

Compaction 主要有以下目的：

1. 回收垃圾：部分算子会产生 DELETE 记录，这也会产生一条 tombstone 记录，在 compaction 的时候需要删除记录。同时覆盖写也需要被合并，回收空间。
2. 整理数据：部分算子在上传的时候会倾向于将同一个 epoch 内不同算子的 state 合并，以减少写放大。然而为了面向后续查询的优化，compaction 会倾向于将同一个算子不同 epoch 的 state 合并，减少读放大。另外，RisingWave 倾向于将计算分布和存储分布尽可能对齐，因此发生 scale-out 后也需要 compaction 来整理数据，这里之后有机会介绍 scale-out 设计的时候再展开，本文不赘述。

执行 compaction 任务的 Compactor 可以灵活部署，既可以挂载在计算节点，也可以由独立进程启动，未来在云上也会支持 serverless 任务来启动。Compaction 任务的调度可以根据用户的需求来调节。如同 [Napa](https://blog.zhuangty.com/napa) 里提到的，如果用户同时需要 freshness 和 query latency，那么理应付出更多的 cost 来执行更频繁的 compaction 任务，反之的话则可以帮用户来省钱。

## Conclusion

如果我们重新 review 一下整个 state store 的设计的话，就会发现这是一颗基于 cloud 的大 LSM 树。每个算子的 local state 和 shared buffer 对应于 memtable（允许 concurrent write，因为所有 stateful 算子保证了 distribution），而 shared storage 里存储的则是 SSTs，meta service 则是一个中心化的 manifest，作为 source of truth，并且根据元信息触发 compaction 任务。

本文简单介绍了 RisingWave State Store 的基本架构和设计上的 trade off。核心思路是尽可能利用云上 shared storage 的能力，享受 remote state 的优势 -- scalability 和更强的弹性扩缩容能力，又希望在 hot state 较小的场景依然能达到 local state 的性能。当然这一切并非毫无代价，而在云原生的架构下，我们可以让这个 trade-off 由用户来选择。

![ ](https://user-images.githubusercontent.com/9161438/166139768-89e161d7-922a-40a2-a508-54da91e83bbd.png)

RisingWave 是一个活跃开发的项目，设计也在活跃迭代中，目前我们也在上述设计之上引入了 Shared State，以减少存储的状态，之后有机会展开介绍。更多的设计文档，可以在 [RisingWave 的 repo](https://github.com/singularity-data/risingwave/tree/main/docs) 找到。
