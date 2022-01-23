---
title: 使用 const generics 实现类型安全的 Builder Pattern
date: 2021-08-01 20:55:00
tags:
- Programming
- Rust
---

一篇搞笑文章 ：（

<!-- more -->

**Builder Pattern**

[Builder Pattern](https://doc.rust-lang.org/1.0.0/style/ownership/builders.html) 是 rust 在复杂对象构造上推荐的一种设计模式，一个常见的 Builder 实现：

```rust
pub struct A {
    a: i32,
    b: i32,
    c: i32,
}

#[derive(Default)]
pub struct ABuilder {
    a_: i32,
    b: i32,
    c: i32,
}

impl ABuilder {
    pub fn a(self, a1: i32) -> Self {
        self.a = a1;
        self
    }

    pub fn b(self, b1: i32) -> Self {
        self.b = b1;
        self
    }

    pub fn c(self, c1: i32) -> Self {
        self.c = c1;
        self
    }

    pub fn finish(self) -> A {
        A {
            a: self.a,
            b: self.b,
            c: self.c,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ABuilder;
    #[test]
    fn it_works() {
        let _a = ABuilder::default().a(0).c(0).b(0).finish();
    }
}
```

---

**必选参数**

这时候我们接到了一些奇怪的需求，要把 a 和 b 作为必选参数（那为什么不把 a 和 b 传进 ABuilder::new 的参数呢，小编也很好奇，但是这么写就水不了文章了）。

我们可以为 ABuilder 引入三个 bit 的常量状态，标识每个参数是否被设置：

```rust
#![feature(const_generics)]
#![feature(const_evaluatable_checked)]

enum Assert<const COND: bool> {}

trait IsTrue {}

impl IsTrue for Assert<true> {}

struct A {
    a: i32,
    b: i32,
    c: i32,
}

#[derive(Default)]
struct ABuilder<const S: u64> {
    a: i32,
    b: i32,
    c: i32,
}

impl<const S: u64> ABuilder<S> {
    fn a(self, a1: i32) -> ABuilder<{S | 1}> {
        ABuilder::<{S | 1}> {
            a: a1,
            b: self.b,
            c: self.c,
        }
    }

    fn b(self, b1: i32) -> ABuilder<{S | 0b10}> {
        ABuilder::<{S | 0b10}> {
            a: self.a,
            b: b1,
            c: self.c,
        }
    }

    fn c(self, c1: i32) -> ABuilder<{S | 0b100}> {
        ABuilder::<{S | 0b100}> {
            a: self.a,
            b: self.b,
            c: c1,
        }
    }
}

impl<const S: u64> ABuilder<S> where Assert::<{S & 0b110 == 0b110}>: IsTrue {
    fn finish(self) -> A {
        A {
            a: self.a,
            b: self.b,
            c: self.c,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ABuilder;
    #[test]
    fn it_works() {
        let _a = ABuilder::<0>::default().a(0).c(0).b(0).finish();
        let _b = ABuilder::<0>::default().a(0).c(0).finish(); // Compilation failed
    }
}
```

迫于无奈，我们开了两个 incomplete feature 来做这个需求，一路顶着 warnings 编译成功了。

在上面的实现里，我们通过一个  `Assert` 的 trick，允许我们在 impl 的 block 上为常量参数 S 添加条件判断，而 S 本质上就是一个 bitflags，标识了某一个参数是否被设置过，为此我们仅为 `ABuilder<S> where Assert::<{S & 0b110 == 0b110}>: IsTrue` 实现 finish 方法，这就满足了我们的需求。

报错大概长这样

```
error[E0599]: the method `finish` exists for struct `ABuilder<{S | 0b100}>`, but its trait bounds were not satisfied
  --> src/lib.rs:70:62
   |
4  | enum Assert<const COND: bool> {}
   | ----------------------------- doesn't satisfy `Assert<{S & 0b110 == 0b110}>: IsTrue`
...
17 | struct ABuilder<const S: u64> {
   | ----------------------------- method `finish` not found for this
...
70 |         let _b = ABuilder::<0>::default().a(0).c(0).finish();
   |                                                     ^^^^^^ method cannot be called on `ABuilder<{S | 0b100}>` due to unsatisfied trait bounds
   |
   = note: the following trait bounds were not satisfied:
           `Assert<{S & 0b110 == 0b110}>: IsTrue`
```

---

**只能传递一次的参数**

此时我们又对 c 提了一些奇怪需求，我们希望 c 是可选参数，但是最多只会被传递一次（即 0 或 1 次）：

举一反三，这个需求太好改了。

```rust
#![feature(const_generics)]
#![feature(const_evaluatable_checked)]

enum Assert<const COND: bool> {}

trait IsTrue {}

impl IsTrue for Assert<true> {}

struct A {
    a: i32,
    b: i32,
    c: i32,
}

#[derive(Default)]
struct ABuilder<const S: u64> {
    a: i32,
    b: i32,
    c: i32,
}

impl<const S: u64> ABuilder<S> where Assert::<{S & 1 == 0}>: IsTrue {
    fn a(self, a1: i32) -> ABuilder<{S | 1}> {
        ABuilder::<{S | 1}> {
            a: a1,
            b: self.b,
            c: self.c,
        }
    }

    fn b(self, b1: i32) -> ABuilder<{S | 0b10}> {
        ABuilder::<{S | 0b10}> {
            a: self.a,
            b: b1,
            c: self.c,
        }
    }
}

impl<const S: u64> ABuilder<S> where Assert::<{S & 0b100 == 0}>: IsTrue {
    fn c(self, c1: i32) -> ABuilder<{S | 0b100}> {
        ABuilder::<{S | 0b100}> {
            a: self.a,
            b: self.b,
            c: c1,
        }
    }
}

impl<const S: u64> ABuilder<S> where Assert::<{S & 0b110 == 0b110}>: IsTrue {
    fn finish(self) -> A {
        A {
            a: self.a,
            b: self.b,
            c: self.c,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ABuilder;

    #[test]
    fn it_works() {
        let _a = ABuilder::<0>::default().a(1).b(1).c(1).finish();
        // let _b = ABuilder::<0>::default().a(1).c(1).c(1).b(1).finish();
        // let _c = ABuilder::<0>::default().a(1).c(1).finish();
    }
}
```

**总结**

这确实是一篇搞笑文章，所有需求都是我在学习 const generics 先进语法的时候随便做的实验，事实上 Builder Pattern 并不适用于这些奇怪的需求，而且用到了 `const_evaluatable_checked` 这种纸糊的 feature 也不可能用于生产。有一个真正用于生产的 crate [typed-builder](https://github.com/idanarye/rust-typed-builder) 思路跟我类似，不过直接生成了一个长度为 n （n 为 fields 的数量）的 tuple 来记录状态，更合理一些。不过基于 `const_evaluatable_checked` 可以实现很多奇奇怪怪的需求，比如可以做编译期状态压缩 DP（rustc 爆炸中），还可以做一些奇奇怪怪的限制（比如限制一个方法最少被调用 n 次，最多被调用 m 次，完全想不到什么场景需要），可以认为是对 Rust typesafe state machine 能力的一个强化了，对于一些比较相似的状态转换过程，我们可以直接基于 const generics 来减少重复代码（DRY）。
