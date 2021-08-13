---
title: "[Paper Notes] Napa: Powering Scalable Data Warehousing with Robust Query Performance at Google"
date: 2021-08-12 20:30:57
tags:
  - Paper Note
  - Database
---

Materialized View 成了最近数据库的新热潮，大数据三驾马车的原厂 Google 也发了一篇 PVLDB，介绍他们替代 Mesa 的新系统 Napa。[Paper 链接](http://vldb.org/pvldb/vol14/p2986-sankaranarayanan.pdf)。随便分享一些 notes 和 unresolved issues（比较乱，不能作为 Paper 的替代品）

<!-- more -->

首先 brief 一下 Napa 这篇 paper 有比较有意思的点：

1. 精细的成本管理，把 trade off 的权利交给用户的同时避免了很繁琐的细节配置。
2. 引入了类似 Watermark 的一个新概念 QT (Queryable Timestamp) 的来向用户描述 freshness（但跟 watermark 有区别）。

## Napa 的核心概念

Napa 是 Google 用来替代 [Mesa](https://research.google/pubs/pub42851/) 的新一代数仓，向 Google 的广告客户以及内部用于分析。一个最重要的变更是引入了 Materialized view 的概念来加速查询。有几个重要的指标是 Napa 关心的：

1. Ingestion throughput：导入数据的速度是至关重要的
2. Query performance：查询请求的性能（延迟）
3. Data freshness：查询到的数据是否更新？一分钟内的数据还是几小时内的数据都行？
4. Resource Cost：每导入一定量数据需要的各种资源。

当然除此之外，Durability 和 Fault tolerance 肯定是必要的。

Ingestion throughput 是不可放弃的选择（数据都导不进去谈什么查询），剩下的都可以交给客户端来 trade off。

### LSMT

Napa 中直接导入数据的表称为 base table，而每个 base table 会有若干关联的 materialized view（n to m 的关系，每个 materialized view 也可能不止关联一个 table）。每个 Materialized view 的结构类似一颗 LSM Tree，一条外部数据从其他系统导入到 Napa 需要经过一系列过程：

1. Ingestion
    对应到 LSM Tree 里应该就是 write memtable + WAL 的过程，不过这里不需要写 memtable，这个类似 WAL 的结构叫做 non-queryable delta，由于更新是 apply 到 base table 上的，所以这个数据只需要写一份 base table，就可以认为 ingestion 成功了，保证了 durability。Ingestion 的过程也会在多个机房同步。
2. Compation and view maintainance: Napa 的 Compaction 混合了好几个概念，我们一个个抽出来：
    * Non-queryable delta -> View Queryable delta
        根据我们上面的描述，Non-queryable delta 只是 base table 的 WAL，那么我们首先需要把这个 log 中的每一项更新读出来，并根据每个 Materialized view 定义的算子进行转换，确定是否要 apply 到对应的 view 中。同时我们也会做一些排序、索引的工作，最后生成的是 n 个 queryable delta（对应于 LSM 中 SST 的概念），n 为需要更新的 view 的数量。
    * Queryable delta merge: 与 LSM 的 merge 完全相同，定期将一部分 Queryable delta 合并为一个更大的 Queryable delta。

而对一个 view 进行一次 query 的过程跟 LSM 也完全相同，即并行地在若干个 delta 进行查询，并将结果合并。

而几个关键的指标基本都受到这套体系的影响：

1. Ingestion throughput：如同 LSM Tree 一样，ingestion 成功即导入成功，高度写优化，导入飞快。
2. Query performance，取决于两个要素：
    * view 的数量，view 的查询性能会比 base table 更好
    * 查询的时候需要对多少个 delta file 查询，越多性能越差
3. Data freshness：Non-queryable 的数据是完全不可读的，因此查询的结果至少会延迟到 non-queryable delta 的合并。除此之外，我们还可以自己选择仅读取一部分的 queryable delta，这样会牺牲 freshness，但是能提高 query performance。
4. Resource costs：Base Table 的更新是必要的，因此可以认为完全是 view 的维护成本，取决于 view 的数量和 compaction 的频率。

### Queryable Timestamp

![QT](https://user-images.githubusercontent.com/9161438/129359740-0114a772-9dca-4b06-9480-869001f4dda8.png)

QT 是一个表示 freshness 的概念，Now() - QT 代表了 frsehness 的 bound。QT 有一个上限，就是不能超过 Non-queryable delta 里的下界（因为 Non-queryable delta 完全不可查询），QT 是受到用户配置影响的。查询时会合并到 QT 为止所有的 delta（而不是全部的 delta）。

### tradeoff query performance

要 data freshness，但 query 可以慢点儿

1. 少建 view，慢慢查
2. 少做 view maintainance task（delta file 会特别多）
3. QT 设置得足够高（查询时会合并所有的 delta file 中的结果）

### tradeoff data freshness

需要 query performance，但是读到的数据可以旧点儿

1. 少做 view maintainance（delta file 会特别多）
2. QT 设置得足够低（查询时需要合并的 delta file 特别少）

### tradeoff resource costs

既要 query performance，又要 data freshness。

![我全都要](https://user-images.githubusercontent.com/9161438/129360955-e3701121-8e26-45da-a970-90e40930ae2e.png)

没有什么是充钱解决不了的。

1. 多建 view。
2. 频繁做 view maintainance。
3. QT 设置得足够高


![tradeoff](https://user-images.githubusercontent.com/9161438/129365009-5c3e40a3-6a95-45ff-b4ad-aaec7355038d.png)

## 外部系统

![Architecture](https://user-images.githubusercontent.com/9161438/129364456-ace178bc-ea96-4250-bf4f-ad88a8c299b3.png)

Google 的 infra 是真的强，所以我感觉其实 Napa 做的最重要的事情就是上面这个 LSMT 了，其他的都通过外部系统解决。Napa 使用了 Colossus（下一代 GFS）做文件存储，并且用 F1 query 做了物化视图的 Planner 和 Optimizer（我觉得是工程量最大的一部分），以及面向客户端的 query servering。Napa 自身更多负责视图的维护。

## Others

**物化视图的自动淘汰**

文中提了很多 challenges，但其中我感觉比较关键的一点，物化视图的及时淘汰。对用户来说，QT 是个 database 级别的概念，如果有一个物化视图的更新比较慢（也许是视图太复杂，或者 plan 优化不够），那么 Now() - QT 就会越来越大，freshness 无法保证，需要及时淘汰掉这些 view（读到这里的时候我才发现原来 view 可能不是用户指定创建的，居然还是可以自动加减的。。就离谱）。

**为什么 QT 不是 Watermark？**

回收一个开头的疑问，因为 Napa 并不是一个 streaming system，它的输入是 Ordering 的（或者说完全基于 Process time 而非 Event time）。Watermark 描述的是 query 的 completeness（即 query time < watermark 代表一定能读到完整的结果），而 QT 描述的是 freshness（即 query time < QT 可以获得符合预期的性能）。

**Napa 提供了怎么样的一致性？**

从我个人的 taste 来看，一个让人用得舒服的数据库，无论是 TP 还是 AP，提供 atomic batch update 和 global snapshot read （即使是 stale snapshot）是必要的选择。这篇 paper 关于一致性的描述非常少，不过两点观察：

1. Mesa 内置了 MVCC，提供了 strong consistency，Napa 作为 Mesa 的 drop-in replacement 不提供的话我感觉用户不会买帐？
2. LSMT 的架构下做 MVCC 是非常简单的事情。

## Summary

总体来说感觉还是比较中规中矩的一些 idea，不过也可以看出 Google 对工程细节的把控非常深了。比如同样是 LSMT 的架构，我怀疑换成 TiDB 的话，robust query performance 可能更取决于查询线程池的调度、gRPC 各种不确定因素而非 delta file 的数量。只有在工程细节上优化得足够好，才能在各个指标上更加可控的 trade off configuration。数据库服务需要很强的确定性，相比于 auto driven 来说，这种 trade off configuration 说不定对用户是个更好的选择。


~~彩蛋：[blog.zhuangty.com](blog.zhuangty.com) 终于用上 Google analytics 了，说不定 tygg 在看报表的时候也用上 napa 了~~
