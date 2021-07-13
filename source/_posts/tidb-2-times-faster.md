---
title: Copy & Paste 三行代码让 TiDB 性能翻倍
date: 2021-07-10 14:07:02
tags:
- TiDB
- Programming
- Open Source
- Database
---

标题党，今天给 TiDB 水了个有意思的 PR，随便写个 blog 记录一下。**文末粉丝福利**

<!-- more -->

上午摸鱼的时候，读了雷宇哥哥的文章 [I beat TiDB with 20 LOC](https://internals.tidb.io/t/topic/174)，这篇文章非常有意思，推荐 go 吹/go 黑都可以读一读，通过这篇文章，我发现了 cgo 比想象的要快很多，以及 go 编译器比想象更烂，以至于 cgo 的 overhead 完全抵消了还不够。在学习 TiDB 先进经验的时候，看到了一段有意思的代码：

```golang
func (b *builtinArithmeticPlusIntSig) plusSS(result *chunk.Column, lhi64s, rhi64s, resulti64s []int64) error {
    for i := 0; i < len(lhi64s); i++ {
        if result.IsNull(i) {
            continue
        }

        lh, rh := lhi64s[i], rhi64s[i]
        if (lh > 0 && rh > math.MaxInt64-lh) || (lh < 0 && rh < math.MinInt64-lh) {
            return types.ErrOverflow.GenWithStackByArgs("BIGINT", fmt.Sprintf("(%s + %s)", b.args[0].String(), b.args[1].String()))
        }

        resulti64s[i] = lh + rh
    }
    return nil
}
```

要理解这段代码，首先我们需要理解什么是 chunk。chunk 是一种列式内存格式，是 [Apache Arrow](https://arrow.apache.org/) 的一种实现，具体可以参考 [TiDB 源码阅读系列文章（十）Chunk 和执行框架简介](https://pingcap.com/blog-cn/tidb-source-code-reading-10/)。对于这里的 Int 类型，Column 的内部其实是一个 int64 array 和一个 bitmap。

![Int64Column 的实现](https://download.pingcap.com/images/blog-cn/tidb-source-code-reading-10/1.png)

这段代码的目的就是将 lhi64s 和 rhi64s 加和的结果保存到 resulti64s 中。为了彻底理解这段代码，我们还需要关注一下调用它的函数 `builtinArithmeticPlusIntSig.vecEvalInt`：

```golang
func (b *builtinArithmeticPlusIntSig) vecEvalInt(input *chunk.Chunk, result *chunk.Column) error {
	n := input.NumRows()
	
	// ...
	// Calculate lh and rh
	result.MergeNulls(lh)
	result.MergeNulls(rh)

	lhi64s := lh.Int64s()
	rhi64s := rh.Int64s()
	resulti64s := result.Int64s()

	isLHSUnsigned := mysql.HasUnsignedFlag(b.args[0].GetType().Flag)
	isRHSUnsigned := mysql.HasUnsignedFlag(b.args[1].GetType().Flag)

	switch {
	case isLHSUnsigned && isRHSUnsigned:
		err = b.plusUU(result, lhi64s, rhi64s, resulti64s)
	case isLHSUnsigned && !isRHSUnsigned:
		err = b.plusUS(result, lhi64s, rhi64s, resulti64s)
	case !isLHSUnsigned && isRHSUnsigned:
		err = b.plusSU(result, lhi64s, rhi64s, resulti64s)
	case !isLHSUnsigned && !isRHSUnsigned:
		err = b.plusSS(result, lhi64s, rhi64s, resulti64s)
	}
	return err
}
```


这段代码主要是根据加法算子两侧表达式的类型，决定调用具体的实现，而 plusSS 则是其中的一种（两个有符号整数相加）。但在调用具体的实现之前，已经对 lh 和 rh 分别调用了 `result.MergeNulls()`，因此在 `plusSS` 中只需要对 result 是否为空进行判断，决定是否跳过计算。

```golang
        if result.IsNull(i) {
            continue
        }
```


```golang
        if (lh > 0 && rh > math.MaxInt64-lh) || (lh < 0 && rh < math.MinInt64-lh) {
            return types.ErrOverflow.GenWithStackByArgs("BIGINT", fmt.Sprintf("(%s + %s)", b.args[0].String(), b.args[1].String()))
        }
```

理解剩下的代码就非常直观了，做一个 overflow 判断，然后返回相加的结果。这也是针对不同符号的 Plus 函数最大的区别。

在 MySQL 大部分 expression 的逻辑，对于输入参数包含 NULL 的情况，输出参数往往也是 NULL，TiKV 为了 DRY，[使用宏简化了这个逻辑](https://github.com/tikv/tikv/pull/8331/files)。

```rust
#[rpn_fn]
pub fn like<C: Collator>(target: BytesRef, pattern: BytesRef, escape: &i64) -> Result<Option<i64>> {
    Ok(Some(
        like::like::<C>(target, pattern, *escape as u32)? as i64
    ))
}
```

这段代码进行宏展开后和上面的 go 代码类似，如果参数有 null 的情况会直接跳过真实 like 的调用。但对于 Plus 这种基础的数学运算函数，事情就有了一些变化。一个常识是，分支的代价其实比 add 这种基础指令大很多，在高效的列式执行逻辑里，这里引入了两个 branch 操作，相比于运算（一次 add）本身来说，这两个 branch 才是最大的 overhead。

且这两个 branch 是必要的 check，同时也是 unlikely 的（大概率会走 else 分支）。在完全不改变代码逻辑的情况下，我们可以[将它们优化成一个 branch](https://github.com/pingcap/tidb/pull/25466)。

```golang
func (b *builtinArithmeticPlusIntSig) plusSS(result *chunk.Column, lhi64s, rhi64s, resulti64s []int64) error {
	for i := 0; i < len(lhi64s); i++ {
		lh, rh := lhi64s[i], rhi64s[i]

		if (lh > 0 && rh > math.MaxInt64-lh) || (lh < 0 && rh < math.MinInt64-lh) {
			if result.IsNull(i) {
				continue
			}
			return types.ErrOverflow.GenWithStackByArgs("BIGINT", fmt.Sprintf("(%s + %s)", b.args[0].String(), b.args[1].String()))
		}
	}
}
```

是的，代码改动只有三行，且只是原封不动 Copy & Paste（点题），我们来看看 benchmark 的结果。TiDB 非常贴心地提供了表达式模块的 benchmark 脚本，我们可以直接使用：

![Benchmark PlusInt](https://user-images.githubusercontent.com/9161438/125152817-e68d9000-e181-11eb-970d-ba39ed400017.png)

可以看到，四种函数的提升都是非常可观的。其中第一个 Case 更是直接性能翻倍。

这个优化的原理是非常简单的，`Plus` 这种基础函数满足两个特性：

1. 运算本身比 check 轻量。
2. 运算不会 crash，且没有副作用。

那么我们可以直接删除 null check 的三行代码，因为 null 的结果已经被写到 result 的 bitmap 里了，这里无脑做一下计算就可以。但由于 overflow check 的存在，我们不能返回非预期的 overflow 错误（可以说 plus 运算本身无状态，overflow check 引入了状态），因此如果发生了 overflow 的话，我们得确认本身不是 null，如果确认不是 null 的话，才返回错误。从某种意义上，这个优化可以认为是手动帮 CPU 做流水线执行。

---

![](https://user-images.githubusercontent.com/9161438/125152990-49335b80-e183-11eb-82cb-dc800574c956.png)

上面的 PR 是我花十分钟写的，我是想再给力一点的，但是懒（躺），下面只说失败的尝试和思路。

首先是想办法优化掉 overflow check 的 branch，我先把 overflow check 的 branch 提取到外侧：

```golang
func (b *builtinArithmeticPlusIntSig) plusSS(result *chunk.Column, lhi64s, rhi64s, resulti64s []int64) error {
+       var hasOverflow int64 = 0
        for i := 0; i < len(lhi64s); i++ {
                lh, rh := lhi64s[i], rhi64s[i]

-               if (lh > 0 && rh > math.MaxInt64-lh) || (lh < 0 && rh < math.MinInt64-lh) {
-                       if result.IsNull(i) {
-                               continue
-                       }
-                       return types.ErrOverflow.GenWithStackByArgs("BIGINT", fmt.Sprintf("(%s + %s)", b.args[0].String(), b.args[1].String()))
-               }
-
+               hasOverflow |= (b2i(lh > 0) & b2i(rh > math.MaxInt64-lh)) | (b2i(lh < 0)&b2i(rh < math.MinInt64-lh))&b2iNot(result.IsNull(i))
                resulti64s[i] = lh + rh
        }
+
+       if uint64(hasOverflow) > 0 {
+               return types.ErrOverflow.GenWithStackByArgs("BIGINT", "overflow")
+       }
        return nil
 }
```

这个优化对逻辑是有变更的，因为报错信息里没法输出正确的数字了，但也不是完全没有办法，考虑到 overflow 是小概率事件，我们可以发现 overflow 以后再循环一次，拿到具体 overflow 的数字。

`b2i` 和 `b2iNot` 大概就是 bool2Int，具体懒得贴了，反正大道至简不需要解释。实测效果大概 benchmark 低了一倍，我又懒得看汇编调优（下次高兴了再水一篇 blog）。猜测有几个原因：

1. Overflow check 比较重，原来可以短路求值的计算现在强制计算了，代价超过了 branch 运算。
2. Go 的优化比较拉，我写的位运算也比较拉。

但总之想优化掉 overflow check 是一件 non-trivial 的事情，

既然解决不了问题，我们不妨解决提问题的人。对于 AP 性能有极致追求的用户，我们可以提供某种 non-strict sql_mode，允许整型 overflow，结果是未定义的，这样我们就能自由地去掉 check 了。

```golang
// 这里已经不需要四种符号的版本了
func (b *builtinArithmeticPlusIntSig) plusNonStrict(result *chunk.Column, lhi64s, rhi64s, resulti64s []int64) {
        for i := 0; i < len(lhi64s); i++ {
                lh, rh := lhi64s[i], rhi64s[i]
                resulti64s[i] = lh + rh
        }
        return nil
}}
```

---

![](https://user-images.githubusercontent.com/9161438/125152990-49335b80-e183-11eb-82cb-dc800574c956.png)

能啊，直接看雷宇哥哥文章的 SIMD 版本 [I beat TiDB with 20 LOC](https://internals.tidb.io/t/topic/174)。

只能说，TiDB 的 Executor 还有很长的路要走（

---

**你是不是标题党？这哪里提升两倍了？**

是，expression 的 benchmark 翻倍，但在整个 SQL 的生命流程中只是微不足道的一部分，特别是 TP 的请求。即使对于复杂的 AP 请求，除非是完全从本地节点的 cache memory engine 中读取的数据，否则相同的数据量网络开销大概率也会超过这部分的优化效果（特别是 TiDB 和 TIKV 交互还用的 gRPC，那就更拉了）。

---

说好的福利（伪）：我改完 Plus 就懒得改了，目测 Sub/And/Or/Not/Xor/... 肯定都能提升的，Mul/Div/Mod 可能需要 benchmark 一下才知道有没有提升，同时 TiKV 上也可以水一堆，感兴趣的可以去水一个 PR 薅 TiDB 的 new contributor 周边杯子。有能力的也可以把 non-strict Plus 实现一下（也很 trivial，就是要思考一下用户接口）。

<!--
option = {
    title: {
        text: 'PlusInt',
        subtext: ''
    },
    tooltip: {
        trigger: 'axis'
    },
    legend: {
        data: ['优化前', '优化后']
    },
    toolbox: {
        show: true,
        feature: {
            dataView: {show: false, readOnly: false},
            magicType: {show: false, type: ['line', 'bar']},
            restore: {show: false},
            saveAsImage: {show: true}
        }
    },
    calculable: true,
    xAxis: [
        {
            type: 'category',
            data: ['VecBuiltinFunc-12', 'VecBuiltinFunc#01-12', 'VecBuiltinFunc#02-12', 'VecBuiltinFunc#03-12']
        }
    ],
    yAxis: [
        {
            type: 'value'
        }
    ],
    series: [
        {
            name: '优化前',
            type: 'bar',
            data: [251072, 505320, 446617, 375538],
            markPoint: {
                data: [
                    {type: 'max', name: '最大值'},
                    {type: 'min', name: '最小值'}
                ]
            },
        },
        {
            name: '优化后',
            type: 'bar',
            data: [537535, 806791, 487568, 442723],
            markPoint: {
                data: [
                    {name: '年最高', value: 182.2, xAxis: 7, yAxis: 183},
                    {name: '年最低', value: 2.3, xAxis: 11, yAxis: 3}
                ]
            },
        }
    ]
};
-->