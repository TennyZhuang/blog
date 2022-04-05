---
title: Zig lang 初体验 -- 『大道至简』的 comptime
date: 2022-04-05 20:11:08
tags:
- Programming
- Zig
---

在很长的一段时间里，系统级的编程语言只有 C 与 C++，使用其中任何一种都不是愉快的体验，这里不作展开。现在许多新的系统项目都使用 Rust 开发。然而这些都不是本文的重点，最近我接触了一个新的系统编程语言 -- [Zig](https://ziglang.org)，今天分享一下试玩的体验。

<!-- more -->



---




![Zig](https://user-images.githubusercontent.com/9161438/161515187-07d053b2-7448-4cd9-8338-776896a2f7fa.svg)

## 简介

全世界有几千种编程语言，任何一个系统学过编译原理的本科生，都可以设计出自己的 toy language 并实现一个 mini compiler。大部分语言都会设计自己喜欢的语法去表达一些通用的基础设施：基础类型、字符串、变量、条件分支、循环、函数、结构体，这些都是朝三暮四、朝四暮三的区别，也不会成为一个语言本质的创新。 本文不会介绍 Zig 的基础语法，而是想安利一下 Zig 的一个重要 feature —— comptime。

C++ 有非常强大的编译期运算能力，meta programming 的魔法层出不穷，且在每个 C++ 版本越迭代越博大精深，然而对于学习者来说，是非常陡峭的学习曲线。Meta Programming 完全是内置于 C++ 编译器的另一套语法非常复杂、报错非常不友好的函数式编程语言。曾经看到过一个观点（来源请求），如果只是为了在编译期生成足够高效的代码，与其将元编程做得越来越复杂，不如直接引入 Python 作为编译期的胶水语言。那么 Zig 就做出了一个类似的选择：**Zig 在编译期引入 Zig 自身作为胶水语言来生成代码，这就是 Zig comptime。**

我们将以[迟先生的类型体操（上篇）](https://www.skyzh.dev/posts/articles/2022-01-22-rust-type-exercise-in-database-executors/) 中实现的一些例子来学习一下 zig。

---

## 例子

迟先生的类型体操中实现的 Array 本质上是 [Apache Arrow 内存格式](https://arrow.apache.org) 的一种实现，我们也可以尝试在 Zig 中实现一下。



### 实现 `FixedArray`

原文中`PrimitiveArray` 存的是可空的定长元素组成的数组，我们不妨将它改名为 FixedArray，由一个代表是否为空的 Bitmap 和存储元素的 collection （这里是 ArrayList）组成。而 `StringArray`（这里简化成 `BytesArray`）是存储变长字符串的集合，由 Bitmap、偏移量数组、和拍平的字符串内容组成。

```zig
const std = @import("std");
const ArrayList = std.ArrayList;
const DynamicBitSet = std.bit_set.DynamicBitSet;

fn FixedArray(comptime T: type) type {
    return struct {
        const Self = @This();
        data: ArrayList(T),
        validity: DynamicBitSet,

        pub const Ref = T;

        pub fn deinit(self: *Self) void {
            self.data.deinit();
            self.validity.deinit();
        }

        pub fn value(self: *const Self, idx: usize) ?Self.Ref {
            if (self.validity.isSet(idx)) {
                return self.data.items[idx];
            } else {
                return null;
            }
        }

        pub fn len(self: *const Self) usize {
            return self.data.len();
        }
    };
}
```

可以看到，在 Zig 中，""泛型类型 `FixedArray` 本质上就是一种接受一个类型，返回一个结构体的函数而已。在这个函数里，我们可以执行任意的表达式检查输入类型参数的合法性，**甚至可以根据输入参数用 if else 返回不同的结构体**。不妨假设我们添加了一个需求：对于 FixedArray，如果每个元素大于 8 个字节，也应该返回引用而非值本身。我们可以改少数代码完成这个需求：

```zig
        // ...
        const sizeLarge = (@sizeOf(T) > 8);
        pub const Ref = if (sizeLarge > 8) *T else T;
        // ...
        pub fn value(self: *const Self, idx: usize) ?Self.Ref {
            if (self.validity.isSet(idx)) {
                if (sizeLarge) {
                    return &self.data.items[idx];
                } else {
                    return self.data.items[idx];
                }
            } else {
                return null;
            }
        }
```

`@This` 很像一般语言里的 receiver，但它其实只是一个的编译器内置的函数，返回了正在定义中的类型参数实例，我们用 Self 为它起了个别名。既然类型只是一种编译期变量，那么相应的 Associated type 也只是结构体上的一个编译期常量而已，我们根据编译期计算的 `@sizeOf(T)` 来确定 `Ref` 的类型。这里 @sizeOf 是一个例子，如果想要，我们也可以用斐波那契数来确定 Ref 的类型 :(



### 实现 BytesArray

原文中实现了 `StringArray` 作为变长数组的例子，这里我们简化为 `BytesArray`。

```zig
const BytesArray = struct {
    const Self = @This();

    data: ArrayList(u8),
    offsets: ArrayList(u32),
    validity: DynamicBitSet,

    pub const Ref = []u8;

    pub fn value(self: *Self, idx: usize) ?Self.Ref {
        if (self.validity.isSet(idx)) {
            const start = self.offsets.items[idx];
            const end = self.offsets.items[idx + 1];
            return self.data.allocatedSlice()[start..end];
        } else {
            return null;
        }
    }

    pub fn deinit(self: *Self) void {
        self.data.deinit();
        self.offsets.deinit();
        self.validity.deinit();
    }

    pub fn len(self: *Self) usize {
        return self.offsets.len() - 1;
    }
};
```

这里更直接了，`BytesArray` 就是个类型为 `type` 的常量。我们也定义了 `Ref` 常量来模拟 `BytesArray` 的『关联类型』。通过将 `Ref` 定义为切片（`[]u8`），我们轻松实现了返回引用而非拷贝数据。



### 实现 BytesArrayBuilder

我们需要一个 Builder 来构造不可变的 array，构造的过程跟读取是类似的。

```zig
const BytesArrayBuilder = struct {
    const Self = @This();

    pub const Array = BytesArray;

    data: ArrayList(u8),
    offsets: ArrayList(u32),
    validity: DynamicBitSet,

    pub fn init(allocator: Allocator) !Self {
        var offsets = try ArrayList(u32).initCapacity(allocator, 1);
        offsets.appendAssumeCapacity(0);
        return Self{
            .data = ArrayList(u8).init(allocator),
            .offsets = offsets,
            .validity = try DynamicBitSet.initEmpty(allocator, 0),
        };
    }

    fn append(self: *Self, v: Self.Array.Ref) !void {
        try self.data.appendSlice(v);
        try self.offsets.append(@intCast(u32, self.data.items.len));
        try self.validity.resize(self.validity.capacity() + 1, true);
    }

    fn append_null(self: *Self) !void {
        try self.offsets.append(@intCast(u32, self.data.items.len));
        try self.validity.resize(self.validity.capacity() + 1, false);
    }

    pub fn finish(self: Self) BytesArray {
        return BytesArray{
            .data = self.data,
            .offsets = self.offsets,
            .validity = self.validity,
        };
    }
};
```

这里有一些小问题，比如标准库的 `DynamicBitSet` 并不能高效地 append 一个 bool，不过可以暂时忽略。我们将 `ArrayBuilder` 和 `Array` 通过 `ArrayBuilder::Array` 关联起来，当然我们也可以顺着 Array 再找到 Ref，如 `    fn append(self: *Self, v: Self.Array.Ref)`。我们也可以在 Array 的结构体中添加对应的 Builder

```zig
pub const Builder = BytesArrayBuilder;
```



### 关联数据库逻辑类型与物理类型

这个对应于 [用 Rust 做类型体操 (下篇)](https://www.skyzh.dev/posts/articles/2022-02-01-rust-type-exercise-in-database-executors-final/#用-macro-关联逻辑类型和实际类型)，得益于 comptime 的简单设计，我们直接逃课了类型体操的大部分。

在原文中，作者用了非常复杂的 macro，用类似 callback 的编程范式来实现了逻辑类型和物理类型的关联，而在**类型即编译期变量**的 Zig 里，这一切都非常自然。

```zig
// 定义 DataType，假设我们支持五种类型。
const DataType = union(enum) {
    SmallInt: void,
    Integer: void,
    BigInt: void,
    Varchar: void,
    Char: u16, // Char 的长度

    // 关联逻辑类型和物理类型
    fn ArrayType(self: DataType) type {
        return switch (self) {
            DataType.SmallInt => FixedArray(i16),
            DataType.Integer => FixedArray(i32),
            DataType.BigInt => FixedArray(i64),
            DataType.Varchar => BytesArray,
            DataType.Char => BytesArray,
        };
    }
};
```

同样，基于 comptime，我们也可以用非常流畅的逻辑将表达式的类型和 DataType 的数组直接映射到表达式的实现，不过这篇 blog 已经太长了，暂时不过多展开了。



### std.MultiArrayList

事实上，Zig 已经在标准库里内置了类似 Multi-dimentional FixedArray 的东西，且非常灵活。

```zig
    const ally = testing.allocator;
    const Foo = struct {
        a: u32,
        b: []const u8,
        c: u8,
    };
    var list = MultiArrayList(Foo){};
    defer list.deinit(ally);
    try list.ensureTotalCapacity(ally, 2);
    list.appendAssumeCapacity(.{
        .a = 1,
        .b = "foobar",
        .c = 'a',
    });
    list.appendAssumeCapacity(.{
        .a = 2,
        .b = "zigzag",
        .c = 'b',
    });
    try testing.expectEqualSlices(u32, list.items(.a), &[_]u32{ 1, 2 });
    try testing.expectEqualSlices(u8, list.items(.c), &[_]u8{ 'a', 'b' });
    try testing.expectEqual(@as(usize, 2), list.items(.b).len);
    try testing.expectEqualStrings("foobar", list.items(.b)[0]);
    try testing.expectEqualStrings("zigzag", list.items(.b)[1]);
    try list.append(ally, .{
        .a = 3,
        .b = "fizzbuzz",
        .c = 'c',
    });
```

可以看到，使用体验都跟 `ArrayList` 几乎完全一模一样，但是内部确实按字段列存储的，它的内部实现大量使用了编译期反射生成友好的代码。这对 [Data-oriented Programming](https://en.wikipedia.org/wiki/Data-oriented_design) 的场景是非常友好的。



## 总结

* Zig 的 const function 非常完善，大部分函数和类型都是 const evaluable 的，这也就意味着编译期 zig 可以无缝对接运行时 Zig。相比之下，Rust `feature(const_eval)` 至今都不支持 heap allocation，只要一个函数用到了 `Vec`, `Box`, `String` 等任何堆上分配的资源，都不能被标记为 `const fn`。
* Zig 有非常完善且原生支持的编译期反射。在 rust 中，https://github.com/dtolnay/reflect 是目前唯一的尝试，且使用起来还是非常不直观。
* Zig comptime 是图灵完备的语言，我们可以自由地实现想要的所有 pattern。
* Zig 可能会面临缺乏类型约束导致编译器报错栈很深的问题，相对来说不是特别友好，但实际体验上，zig comptime 的 stack 还是非常易懂的，而且这可以后续引入 constraints 来解决。



## 对比一些其他的方案

对比 C++ template：

* C++ meta programming 非常强大，图灵完备，绝对可以做到 zig comptime 同等的能力
* C++ meta programming 和 C++ 本身是两套语言
* C++ meta programming 运行非常慢
* C++ meta programming 可读性非常差
* 会 C++ 的人很可能学不会 C++ meta programming（比如我）
* Zig comptime 和 Zig 完全是一套语言，会 zig 就会 zig comptime，而且可以复用几乎所有的基础设施（参考上文）

对比 External generator（ `go generate` 或 `build.rs`） 等方案：

* 编译器内置支持而不仅仅是工具链支持
* 基于字符串的复用在造库的时候编程体验比较差
* 由于完全是由工具链（如 cargo）驱动的两个过程，在 compile 和 runtime 互相引用也只能基于字符串作为约定，很不安全。

对比 rust proc-macro：

* 与 zig 相似，proc-macro 也可以用原生 rust 进行开发
* proc-macro 基于语法树开发，相比于大部分抽象需要的信息来说过于底层，coner case 非常多，且很容易 break change。
* zig comptime 拿到的是更上层的信息，`@TypeOf`, `@field` 等都可以拿到非常开箱即用的信息。

对比 Generics：

* 相比于语言本身，都没有引入很高的复杂度
* Zig 图灵完备，能够 zero overhead 实现的抽象非常多，且不需要引入复杂的设计和学习成本。
* 不用类型体操
* 报错会更晦涩，安全性检查上会更弱（可以引入 constraint）。

如果要用一个合适的词形容 zig comptime 的话，我觉得『大道至简』是一个非常好的描述。这不仅仅是在玩梗，而是一种真实的感受。

作为大道至简的代表，Golang 在 1.18 之前一直不支持泛型广为人诟病，但 Golang 设计之初就是不希望引入过高的复杂度和学习负担，我其实可以理解这个选择（这不妨碍我不想写 Golang）。在最新的版本里，Golang 引入了一个非常残废的 Generics，支持的功能非常有限。而如果想支持更多的抽象需求，不可避免的要引入一些相对复杂的设计如 covariance，partial specification，甚至 higher kinded type，这也背离了 Golang 的设计初衷。也许对于 Golang 来说，在 1.17 的 IF 线里，选择从 `go generate` 进化到 comptime 是更好的选择 —— 用更低的复杂度和学习成本换来了非常强大的抽象能力。

---

Zig 依然是个比较早期的语言，没有发布 1.0 版本。相比于 Zig，我也更喜欢使用 Rust，但 Zig 依然有一些非常惊艳的 feature，comptime 只是其中之一。同时 Zig 也有非常好的交叉编译基础设施，我很期待 Zig 能成为未来系统编程语言中 C 的一个重要替代品。
