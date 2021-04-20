---
title: 解锁 TiDB Hackathon 一等奖的新体验：TiDB + Wasm
date: 2021/04/20 20:00:00
tags:
  - Programming
  - Database
  - TiDB
  - Hackathon
---



前段时间，因为比较活跃在 TiDB 社区，所以顺手参加了 TiDB 2020 Hackathon。这次选的参赛题目是一个老生常谈的功能：UDF（User Defined Function）。

<!-- more -->

## 彩蛋



尽管是完全与安全方向无关的主题，但我们随手取了个队名 ' or 0=0 or '（读作「引号or零等于零or引号」），除了可以卖萌，而且还能用于 SQL 注入，感兴趣的可以看看[万能密码](https://zhuanlan.zhihu.com/p/24471576)这个 topic。很意外的是还引发了 hackathon 过程中一个有趣的小插曲，在看到我们的队名后东旭和姚老板纷纷吐槽太有年代感了：

![年代感.jpg](https://user-images.githubusercontent.com/9161438/111075420-e4dcf400-8522-11eb-8203-b9b834926bbc.png)

但仅仅过了半天，在我们 hack 的途中，我们的队友 breeswish 就无意中发现 TiDB 的内部 SQL 存在原始的字符串拼接参数且没有校验参数合法性，成功地进行了一次提权攻击 ：D

![提权注入成功](https://user-images.githubusercontent.com/9161438/111075565-8fedad80-8523-11eb-9fe9-9bdee5a54435.PNG)




## 我们想做什么？

每年的 TiDB Hackathon 其实都会有 UDF 的 proposal，这里面也包括我在 2018 年参赛时实现的基于 lua 的 UDF。当时的实现非常粗糙，我们在 TiDB/TiKV 上直接起了一个 lua vm，然后允许用户以 CREATE FUNCTION 的语法把 lua 函数上传到 TiDB 并保存在 PD，同时支持用户通过 `call_lua(fn_name, args)` 的语法来调用 UDF。TiDB/TiKV 的执行器会从 PD 加载函数 body，并通过 lua vm 执行。这个方案有许多问题，以至于只能是一个 demo，始终无法落地：

1. lua 生态较差，仅适用于实现一些功能简单的函数。而类似方法支持更多语言需要 TiDB 内置多种 vm。
2. 与 vm  的交互开销较高，UDF lua 相比 native 函数，执行效率偏低。

lua UDF 这个项目也因此很遗憾没有拿奖。~~一个没被采用的队名：MAKE UDF GREAT AGAIN!~~

得益于 TiDB 本身是开源的，有 UDF 需求的用户可以通过修改源码的方式（非常简单），添加自定义函数并自行部署。然而随着 Cloud Native 时代的到来，DBaaS 成为了越来越多用户使用数据库的方式，这种方式不再适用 —— 公有云用户无法修改 TiDB/TiKV 的二进制文件。在 2020 TiDB Hackathon 选题的时候，我们又把这个 topic 重新捡了起来，与之前不同的是，这次我们不再是 idea driven hackathon，更多关注的是方案可落地，**让 UDF 这个选题从未来的 Hackathon 中消失**，在设计之初，我们就定下了若干目标：

1. 灵活性：应该支持更多的编程语言进行 UDF 的编写。不同人对编程语言的喜好大相庭径，强迫 TiDB 的用户使用 lua 编写 UDF 并不是一种优美的做法。
2. 安全性：数据库的安全性至关重要，应该保证函数在沙箱环境运行，不能造成权限泄漏，也应该尽可能减少对业务稳定性的影响。
3. 高效性：性能接近 Native 函数，用户不需要担心额外的 overhead。
4. 功能：在保证安全的前提下，提供数据库内部的 API 以及对外的网络 API 到 UDF 的沙箱环境，同时这些 API 也在权限控制的管理下。



## 我们做了什么？

为了不引入过多过重的 runtime，增加维护的心智负担，我们选择了 Wasm 作为解决方案。Wasm 本身我不过多介绍了，感兴趣的同学可以在很多地方找到详细的介绍。最关键的是，Wasm 拥有我们想要的所有 feature。Wasm 是面向浏览器的沙箱环境安全执行设计的一种 low-level 指令，同时也兼备接近 native 代码的高性能，之后也被扩展到非浏览器的平台运行。（其实我觉得这玩意早该有了，但确实还是要依赖各大巨头合作才能定义出一套大家都接受的标准）

选定了 Wasm 作为技术方案以后，剩下的工作就是选择一个合适的 runtime，并且嵌入到 TiDB/TiKV 的执行器中。由于同时需要兼容 C、Go、Rust 语言，我们选择了 [Wasmer](https://wasmer.io/) 作为我们 demo 时的 runtime，并且使用了 llvm backend 达到了接近 native 的性能。



#### 使用

```c
#include <emscripten/emscripten.h>
#include <stdint.h>

uint64_t EMSCRIPTEN_KEEPALIVE
udf_main(uint64_t a, uint64_t b) {
    return a + b;
}
```

假设用户先基于 emscripten 工具链实现了一个简单的函数 aplusb，由于这里的类型完全是 Wasm 原生类型，因此也不需要做任何额外的处理。

```bash
$ emcc aplusb.c -O3 -o aplusb.wasm --no-entry -s ERROR_ON_UNDEFINED_SYMBOLS=0
# 由于 Wasm 是一种 binary 的格式，我们做了一些简单的处理
$ cat aplusb.wasm | od -v -t x1 -A n | tr -d ' \n'
0061736d010000000117056000017f60000060017f0060017f017f60027e7e017e0307060104000203000405017001020205060101800280020609017f01419088c0020b077a08066d656d6f72790200087564665f6d61696e0001195f5f696e6469726563745f66756e6374696f6e5f7461626c6501000b5f696e697469616c697a650000105f5f6572726e6f5f6c6f636174696f6e000509737461636b5361766500020c737461636b526573746f726500030a737461636b416c6c6f6300040907010041010b01000a30060300010b0700200020017c0b040023000b0600200024000b1000230020006b4170712200240020000b05004180080b
```

用户可以通过 CREATE FUNCTION 命令将这段 wasm bytecode 传给 TiDB：

```
mysql> CREATE FUNCTION aplusb WASM_BYTECODE x"0061736d010000000117056000017f60000060017f0060017f017f60027e7e017e0307060104000203000405017001020205060101800280020609017f01419088c0020b077a08066d656d6f72790200087564665f6d61696e0001195f5f696e6469726563745f66756e6374696f6e5f7461626c6501000b5f696e697469616c697a650000105f5f6572726e6f5f6c6f636174696f6e000509737461636b5361766500020c737461636b526573746f726500030a737461636b416c6c6f6300040907010041010b01000a30060300010b0700200020017c0b040023000b0600200024000b1000230020006b4170712200240020000b05004180080b";
Query OK, 0 rows affected (0.33 sec)

mysql> SELECT aplusb(1, 4);
+--------------+
| aplusb(1, 4) |
+--------------+
|            5 |
+--------------+

mysql> SELECT aplusb();
ERROR 1582 (42000): Incorrect parameter count in the call to native function 'aplusb'
```

![image](https://user-images.githubusercontent.com/9161438/115414212-6d3c6c00-a228-11eb-889d-8f2c83e10335.png)

创建后，UDF 的 Wasm bytecode 会被存在一张系统表中，在某个节点首次执行后会被编译执行并且缓存在该节点上。

当然对于大段的 bytecode，这种方式其实不友好，可能后续需要提供一些上传工具。（不过这并不是 hack 需要考虑的事情


#### 高性能

我们分别用 Wasm UDF 和 TiDB/TiKV native code 实现了一个叫 [nbody]([add builtin nbody · tidb-hackathon-2020-wasm-udf/tidb@bbcf0d5 (github.com)](https://github.com/tidb-hackathon-2020-wasm-udf/tidb/commit/bbcf0d5748a6462e1030bca07b30d848ea250648)) 的函数用作性能测试。我们很意外地发现 UDF nbody 比 rust nbody 大致相近（符合预期），但居然比 go nbody 快一些 ~~（说明 golang 辣鸡）~~，猜测是 allocator 的问题。这个实验也充分证明了 UDF 的高性能。

#### 灵活性

这其实是我们在 Wasm 上踩坑最多的地方，Wasm 的接口比较 low level，因此一些高级语言的数据结构（其实从需求上来说主要就是 string）映射到 Wasm ABI 会有不同的表示，我们还是需要为每种语言定制一下工具链来生成符合我们预期的 Wasm bytecode。

我们分别用 rust/golang/C 实现了 UDF 的功能，在尝试 Java 时，我们踩了比较大的坑，感觉 Java compile to Wasm 的工具链都比较不成熟。目前来看，Wasm 生态比较好的其实是运行时更轻量的静态语言。

#### 安全性

![execution](https://user-images.githubusercontent.com/9161438/115404999-6b6eaa80-a220-11eb-8472-d2b28080b2ff.png)

Wasm 本身是个安全的沙箱执行环境，我们可以主动提供一些 API 给用户调用，并且配合权限认证。为了演示这个功能，我们实现了一个 HTTPGet 的函数，同时对接了 TiDB 本身的 Privilege 系统 —— 有 UDFNetworkPrivilege 权限的用户才能顺利创建和执行这个函数。这其实给 TiDB 与云生态结合提供了很大的想象空间。



---



最后我们在 Demo 的时候演示了一个非常 fancy 的东西：我们复用了上一届 Hackathon 二等奖的一个成果，他们做的是[基于 Wasm 让TiDB 运行在浏览器里](https://pingcap.com/blog-cn/tidb-in-the-browser-running-a-golang-database-on-wasm/)，然后我们直接复用他们的 Wasm 实现了**让 TiDB 跑在 TiDB 里**

```sql
# TiDB 套娃
SELECT wasm_tidb('SELECT tidb_version();');
SELECT wasm_tidb('use test; create table t1 (id int primary key); insert into t1 values (1); select * from t1;');
```



## Not only UDF

我们的参赛主题写的是 TOT（TiDB over TIDB），事实上我一开始是想展示三种 TOT 的 demo（很遗憾的是我们最后只实现了两种）：

1. TiDB 通过 UDF 访问云上的另一个 TiDB，展示 UDF 可以提供受沙箱限制的网络能力，为云上和其他服务联动提供想象空间。
2. TiDB 通过 UDF 运行另一个编译成Wasm 的 TiDB，展示 wadm 强大的可扩展性，我们甚至可以把 TiDB 本身移植上去（见上文）。
3. **在 UDF 中暴露受控的合适的内部接口，例如执行一些查询/修改，达到类似存储过程的效果。**

至少在互联网公司的数据库应用中，存储过程已经是基本被抛弃的功能。存储过程有很多众所周知的缺点：

* 语法和主流语言有差异，且缺乏统一标准，难以 port 到其他架构
* 通常表达能力较弱，容易写错
* 难以根据业务模型封装
* 占用数据库计算资源，难以控制存储过程的复杂度，容易把 DB 打挂
* ......

而基于 Wasm 的存储过程，可以基本避免上面提到的缺点：

* 不再拘泥于特定的 DSL，凡是能编译到 Wasm 的语言都能运行在 DB 上，业务很容易 port 代码，且 GPL（general purpose language）的表达能力通常比 DSL 强大很多。
* 运行在各种架构上，一处编码处处运行（JVM：？）
* 借助 jit 达到接近 native 的性能，特别是如果 DB 本身是基于 query compilation 的执行器的话，可以把整个 query 的完整执行逻辑直接编译成媲美手写的最佳性能。（当然 TiDB 不行）
* 借助 Wasm 本身的沙盒机制保证安全性。

这样自由又强大的 ”存储过程“ 已经接近于数据库内部的 Serverless 了，相比直接用 Serverless ，做在数据库内部有什么好处，这又是另一个很大的 topic 了，下次有灵感了再写（🕊）。

最近经常学习 Manjusaka 老师的 Blog，感受了 ePBF 给内核可观测性带来的变化。事实上 Wasm 也可以做到类似的事情。除了实现存储过程，Wasm 还可以用于用户自定义 Trigger。这个 Trigger 不仅仅可以在数据修改时执行，在如获取 TSO，下推计算、数据复制，等所有具有观测价值的地方都可以进行一些埋点对 UDF 调用，而在 UDF 内部可以灵活高效地采集监控信息，甚至可以通过受限 API 跟用户生态或者云生态内的其他系统汇报采集到的信息，这可以给数据库系统带来巨大的可观测性提升。

## 总结

总的来说是一次非常充实的 Hackathon，在一次 Hack 的过程中我们不仅需要跟 TiDB、TiKV 打交道，还了解了各个语言工具链特别是大量 Wasm 周边生态有关的知识，工作量非常的大，感谢队友大腿们 breeswish，Fullstop000 和 Hawkingrei 的带飞。

在给评委答辩~画饼~的时候，事实上我也感受到了 Wasm+Wasi 在服务器领域的巨大潜力，如果 Wasm 能在更多系统中大规模落地的话，能在保证数据安全的前提下给用户带来更强更灵活的定制能力。这个 Hackathon 项目也是为这个过程做了一点微小的贡献~
