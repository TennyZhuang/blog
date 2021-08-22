---
title: "[Paper Notes] Noria: dynamic, partially-stateful data-flow for high-performance web applications"
date: 2021-08-22 14:19:34
hide: true
tags:
  - Paper Note
  - Database
---

最近读了 [Noria](https://pdos.csail.mit.edu/papers/noria:osdi18.pdf)，一个物化视图系统的实现（虽然它自称是 Dataflow）。这篇 Note 包含大量本人脑补。

![Noria](https://user-images.githubusercontent.com/9161438/130350687-07f358b7-4eb1-4e71-ac9c-c48d40aaf033.png)

<!-- More -->

## Abstraction

从最简单的概念来说，Noria 就是一个异步的增量物化视图，每条更新被异步地推送到用户创建的每个 External View 上用于查询，这些是计算图的叶子节点。

![](https://user-images.githubusercontent.com/9161438/130350909-df3ffc5f-a29c-4c8d-8126-63deb65cd174.png)

这跟 Streaming system 也比较像，唯一的区别是它本身就是个数据库，因此它持久化了 Base Table。主体不记录了，主要讲讲它的一些特殊设计。

## Join

![Window Join](https://user-images.githubusercontent.com/9161438/130347182-1092ff0f-6d92-45e7-bba1-5b8788a5b80b.png)

Window Join 是 Flink 的算子之一，Window Join 的两个上游算子的输入流仅在一个时间窗口内的才会被合并，而一些变体如 Interval Join，只不过是把这个时间窗口从一个矩形变成了三角形或者梯形。这种流式 Join 跟传统数据库的 Join 有很大区别，仅能处理一部分场景。很多 Join 往往并不是在一个窗口发生的，比如老用户和新订单之间的 Join 就无法通过这种 Window Join 完成，而需要借助一些其他的系统，比如维度表。当然 Flink 只是个流式计算引擎，不可能在 join 算子维护太多的状态，只支持一个窗口是正常的。Noria 的定位则是一个流式数据库，它希望解决所有的 Join 需求。Noria 会在 Base Table 上保存所有数据，而 Join 算子上仅保存部分状态。在 Join 无法匹配成功时，通过递归的 upquery 向上查找，直到落到 Base Table 为止。（这其实很类似 TP 里增量物化视图的做法了）

![Join Upquery](https://user-images.githubusercontent.com/9161438/130350256-295dd847-ec99-43d2-b447-b82c282052c0.png)

## Partial State && Upquery

Partial State 和 Upquery 是贯穿 Noria 整个系统的，而不仅仅是为了解决 join 的问题。当我们在 Noria 里新建一个物化视图时，这个视图以及所有新建的算子都是 Empty State 的。这也就给 Noria 带来了一个好处，算子变更非常地简单且快速。在有对这个视图的查询到来时，会通过 Upquery 向上 Upquery 查询数据（直到 Base Table），并一路向下填充每个算子的状态。而当整个系统状态过多时，又会通过一些策略 Evict 掉一些算子的部分状态，在需要的时候重新 upquery 计算。这样整个系统的空间占用就是 bounded 的。

![Noria with evicted state](https://user-images.githubusercontent.com/9161438/130351024-0c9f6030-3678-434b-a4e4-c4bafb3b0257.png)

## 一致性

Noria 提供了 eventually consistency 的语义保障。对 Noria 的每个算子来说，会有两个操作：来自上游的 Update 和来自下游的 Upquery，Upquery 本身不会修改这个算子的状态，但 Upquery 的结果是会用于计算更下游算子的更新数据的（类似读后写），因此也会影响最终一致性。Noria 的做法是在每个算子上提供 Update/Upquery 的 Ordering，类似于 Lock Based 的思路，而不是引入 MVCC。脑补了一下，如果是基于 MVCC 的实现，Upquery 会查到一个 snapshot 的数据来更新下游，那么就会稳定产生 write skew，而达不成 eventually consistent。

## 一些个人看法

我觉得 Noria 最大的亮点是这个设计把 Streaming 和 Query 做到了同一个引擎里，区别仅仅是在计算图上流向的区别 —— Query 是从叶结点（External View）到根节点（Base Table）向前地 Pull 数据并选择性地缓存，而 Streaming 则是从根节点向叶结点 Push 数据的更新。从另一个角度看，Noria 的每个 External View 都是 Logical View 和 Materialized View 按照一定比例混合的结果，而 Eviction 策略调整两者的比例，我们考虑两种情况：

1. Evict All：所有算子都被当成 Stateless 的，这种情况下所有的查询都会走 upquery，等于典型的 AP 查询。
2. Evict None：所有算子都保存 Full State，所有查询都只走叶子节点的 External View。

实际的状态则是多个维度 trade off 过的 Partial State：

1. 访问频率更高、重新计算代价更高、状态存储占用更低的状态更倾向于被保留。
2. 访问频率更低、重新计算代价更低、状态存储占用更搞的状态更倾向于被淘汰。

这种 Partial State 符合大量应用的特征，很多分析往往是更关注头部用户的分析结果，头部用户无论是产出内容还是粉丝数交互数都更多，相同的查询重新计算的代价也高。而应用的不活跃用户往往查询频率很低，且重新从 Base Table 计算代价也很低，用跟头部用户相同的状态（空间、写放大）为他们维护所有 View 是很不划算的事情。Noria 可以全自动地做这个事情。

从这个结果来看，Noria 在开头对自己的定位就非常精准了，它是一个 eventually consistency、near realtime、以及**非常易于使用**的 Redis 替代品，用户可以像直连数据库一样达到缓存的效果，同时还有更好的缓存语义。

这套设计可以极大改进现在应用开发者对数据库地使用方式，举个实践上更强的例子，现在网站对内容点赞、评论等的计数往往是需要业务手动维护：

```sql
BEGIN;
INSERT INTO `likes` (`user_id`, `tweet_id`) VALUES ("zty0826", "496733277274013696");
UPDATE `tweets` SET `like_count` = `like_count` + 1 WHERE `tweet_id` = "496733277274013696";
COMMIT; 
```

除了简单的业务逻辑，我们还需要维护各个缓存的状态，like_count 只是最简单的状态之一。基于 Noria，我们可以用物化视图的方式去做这个：

```sql
CREATE MATERIALIZED VIEW `tweet_likes` AS
SELECT `tweet_id`, count(1) FROM `likes` GROUP BY `tweet_id`;
```

不同于经典物化视图的是，Noria 里的 tweet_likes 表可以仅维护远远少于 tweets 表量级的状态。像 496733277274013696 这种热门、常看常新的 tweet 状态肯定会被长期缓存在 tweet_likes 表里，而大量冷门的、过期的甚至从来没有人看过的 tweet 则只会存在于 Base Table（likes）中，即使偶尔需要，查询代价也非常低，当一个冷门 tweet 114514114514 因为某种未知原因被查询，tweet_likes 表里早就淘汰了对应的数据时，Noria 会自动 Upquery，等效于对 Base Table 执行了一个查询：

```sql
SELECT count(1) FROM `likes` WHERE `tweet_id` = "114514114514";
```

这个案例听起来更像 ”HSTP“（自造词） 而不是 HSAP？总之，大量复杂的逻辑都被 Noria 接管了，因此业务代码只需要维护最简单的逻辑就够了，通过一套系统处理这些还是很 fancy 的。

上面是从数据库物化视图的角度看待这个系统，接下来从 streaming system 的角度来看它解决的问题（主要是有 Base Table 就能做很多事情）：

1. 有对历史数据查询的能力，解决了 Join 算子语义不足的问题。
2. Paper 中没提，但根据我的想象，对 Watermark 的策略可以更激进和自动化，反正如果 Lateness 多了就可以 evict 掉中间算子的状态，重新从 Base Table 算。

吹完喜欢的点，聊聊局限性：

1. 状态维护：Incremental materialized view 的状态维护逻辑本身就非常复杂，对所有 SQL 算子完整支持的复杂度远超查询引擎，而 Noria 为这个本来已经非常复杂的状态维护又引进了 Partial State。从 [Noria 开源的代码](https://github.com/mit-pdos/noria)来看，它的算子支持是非常有限的。
2. 操作支持：很多算子对 Update/Delete 的支持是非常难的，比如 min/max/distinct/...，Noria 直接绕过了这个问题（暂时只支持 Insert）。
3. 确定性：基于这个设计，系统可以调整的参数太多，一个查询的不确定性更高，非常依赖于每个算子的 Eviction 策略，一旦预测错误就会引起大量查询甚至雪崩，这个要做好 QoS 的挑战也更大。

Noria 这篇 paper 做了一个开源实现，是一个 45k 行代码的 toy，而且我并没有 run 起来，疑似已经停止维护了。相对于真正可以使用的数据库产品，还有很多复杂的情况需要处理，不过这个设计思想还是给了很多想象空间。
