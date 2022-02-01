---
title: notes
---

**置顶**

这个页面用于记录一些有灵感的小想法，或者学到的有意思的东西。

正确的姿势显然不是用一个 hexo page 来表示，但在找到一个定制性足够强的框架之前，我决定躺平摆烂 :(

每条 note 通过分隔线隔开，链接是通过一个手写的 html id 生成的，凑合用用先

---

## Rust 中的 `{ v }.split_at_mut(mid)` 是一种行为艺术吗？

[date: 2022-02-01 23:36](#202202012336)

今天浏览 rust 代码的时候发现 rust 的 quicksort 里有一段神奇的代码。

```rust
let (left, right) = { v }.split_at_mut(mid);
```

`{ v }` 显然是个 block expression，但是直接返回自身的话，为什么不直接使用 `v.split_at_mut(mid)` 呢，并且去掉以后也能正常通过编译。乍一看以为是作者的一种行为艺术，并不会对代码产生任何影响。

跟群友讨论了一下以后，发现这其实是间接让 `v` 被 move 进了 block，从而阻止 `v` 被后续继续使用。

我们可以通过下面这个例子完全理解这种用法：

```rust
struct A;
impl A { fn f(&mut self) {} }
fn main() {
    let mut a = A;
    let pa = &mut a;
    pa.f();
    pa.f();
    { pa }.f();
//    -- value moved here
    pa.f();
//  ^^^^^^ value borrowed here after move
}
```

---
