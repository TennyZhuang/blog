---
title: Design a collection with compile-time reference stability in Rust
date: 2024-01-26 19:03:00
tags:
- Programming
- Rust
---

LRU Cache 是工业界最常用的数据结构之一，而最简单的实现方式是基于 HashMap 和链表。当访问某个 entry 时，这个 entry 会被移到链表的最前端。

![LRU-Cache](https://s2.loli.net/2024/01/26/hQNLxjarMkGIi4g.png)

Rust 有个 crate [lru][lru-rs] 实现了这个数据结构，这里摘取了几个关键方法：

```rust
impl<K: Eq + Hash, V> LruCache<K, V> {
    pub fn new(cap: usize) -> LruCache<K, V> {todo!()}
    pub fn len(&self) -> usize {todo!()}
    pub fn put(&mut self, k: K, v: V) -> Option<V> {todo!()}
    pub fn get<'a>(&'a mut self, k: &K) -> Option<&'a V> {todo!()}
    // get the mutable reference of an entry, but not adjust its position.
    pub fn peek_mut<'a>(&'a mut self, k: &K) -> Option<&'a mut V> {todo!()}
}
```

相比于 [lru][lru-rs]，这里对函数签名做了一些简化，省去了与 `Borrow` trait 有关的优化。

可以看到，与常规数据结构不同的是，这里的 `get` 方法，也需要接受 `&mut self`，这给使用者带来很多困扰。例如我们可能希望同时持有多个 `V` 的不可变引用，这可以允许我们减少不必要的 copy，或者并发地使用他们。

<!-- more -->

```rust
let x = cache.get(&"a").unwrap().as_str();
let y = cache.get(&"b").unwrap().as_str();
let z = cache.get(&"c").unwrap().as_str();
[x, y, z].join(" ");
```

我们会得到如下报错：

```
error[E0499]: cannot borrow `cache` as mutable more than once at a time
   |
20 |     let x = cache.get(&"a").unwrap().as_str();
   |             ----- first mutable borrow occurs here
21 |     let y = cache.get(&"b").unwrap().as_str();
22 |     let z = cache.get(&"c").unwrap().as_str();
   |             ^^^^^ second mutable borrow occurs here
23 |     [x, y, z].join(" ");
   |      - first borrow later used here
```

很显然，`LruCache::get` 使用了 `&mut cache` 导致 `x` 已经占有了 `cache` 的可变引用，而后面尝试创建 `y`、`z` 多个 `&mut cache` 同时存在违背了 Rust 的 borrow checker。

那么 Borrowck 认为是错的，就是错的吗？如果我们再看一眼上图演示的 `LruCache` 在 `get` 过程中的调整，我们会发现这个限制是完全没有道理的。`get` 确实会调整 `LruCache` 的结构，但并不会影响 `val` 的指针，第二次 `get` 完全不会让第一个 `get` 获得的 `&V` 失效。

那么反正实现是 unsafe 的，我们可以将 `get` 改成接受 `&self` 吗？

```rust
pub fn get<'a>(&'a self, k: &K) -> Option<&'a V> {todo!()}
```

这显然是错的，接受 `&self` 意味着我们可以并发调用 `get` 方法，链表就会被彻底破坏导致 UB，除非我们使用 `Arc<Mutex<_>>` / `AtomicPtr` 等同步原语保护链表节点引入不必要的 overhead，或者将 `LruCache` 标记为 `!Sync`，这与我们原本的目的背道而驰了。

我们希望有一种接口设计，它不允许我们并发调用 `get` 方法，但 `get` 返回的 `&V` 不独占整个 cache，从而允许我们合法地同时持有多个 `&V`.

```rust
pub fn get<'cache, 'key>(&'cache self, k: &'key K) -> Option<&'? V> {todo!()}
```

这个函数目前有两个生命周期参数，一个是对 cache 的引用 `'cache`（前文中的 `'a`） ，另一个则是完全无关，甚至可能非常短的 `'key` （在前文中我们利用 rust 的规则省略了这个参数）。这两个都不可能描述我们返回值的生命周期，我们需要一个更好的生命周期参数，基于这个思路，我们尝试引入了一个新的生命周期：`'token`。

```rust
pub struct Token;
pub fn get<'cache, 'key, 'token>(&'cache self, k: &'key K, token: &'token Token) -> &'token V { todo!() }
```

这样我们之前同时持有多个 `&V` 的代码就能编译通过了！Happy Ending？

```rust
let x = cache.get(&"a").unwrap().as_str();
let y = cache.get(&"b").unwrap().as_str();
let z = cache.get(&"c").unwrap().as_str();
cache.put("a", "b".to_string());
[x, y, z].join(" ");
```

我们很快发现在修改了 `get` 的签名后，我们在 safe rust 中，在 `&V` 仍然合法时调用 `push`。这个方法会覆盖现有的 value，或者淘汰最旧的 entry。被覆盖的 entry 会在返回后被 drop。在此之后我们继续访问 `x` 就会导致 UB。办法也非常简单，我们只需要修改 `put` 的签名即可。

```rust
pub fn put<'cache,'token>(&mut self, k: K, v: V, token: &'token mut Token) -> Option<V> {todo!()}
```

```rust
let x = cache.get(&"a").unwrap().as_str();
let y = cache.get(&"b").unwrap().as_str();
let z = cache.get(&"c").unwrap().as_str();
cache.put("a", "b", &mut cache);
[x, y, z].join(" ");
```

由于 put 需要 &mut Token 作为参数，而 `&Token` 已经被 `x`/`y`/`z` 不可变引用了，这里会编译失败。

现在我们可以给 `Token` 一个更好的名字了，不难发现，`Token` 其实是对 value 本身的读写权限。我们将它重命名为 `ValuePerm`。

* 持有 `&self`，代表对 `LruCache` 的结构有读权限。
* 持有 `&mut self`，代表对 `LruCache` 的结构的结构有写权限。
* 持有 `&perm`，代表对 `LruCache` 的 `value` 有读权限。
* 持有 `&mut perm`，代表对 `LruCache` 的 `value` 有写权限。

```rust
impl<K: Eq + Hash, V> LruCache<K, V> {
    pub fn new(cap: usize) -> LruCache<K, V> {todo!()}
    pub fn len(&self) -> usize {todo!()}
    pub fn put<'cache, 'perm>(&'cache mut self, k: K, v: V, perm: &'perm mut ValuePerm) -> Option<V> {todo!()}
    pub fn get<'cache, 'perm>(&'cache mut self, k: &K, perm: &'perm ValuePerm) -> Option<&'perm V> {todo!()}
    // get the mutable reference of an entry, but not adjust its position.
    pub fn peek_mut<'cache, 'perm>(&'cache self, k: &K, perm: &'perm ValuePerm) -> Option<&'perm mut V> {todo!()}
}
```

我们选取的函数是非常典型的四种用例。一个意外的收获是，由于 `peek_mut` 不持有 `&mut self`，它返回的引用可以和 `len` 同时调用，虽然这可能是个没什么用的 feature。

```rust
let val_mut = cache.peek_mut(&"a", &mut perm);
let len = cache.len();
dbg!(val_mut);
```

下一个要解决的问题是唯一性。很显然，一个 `LruCache` 只能被一个 `Token` 操纵，这里我借鉴了 [Ghost Cell][ghost_cell] 和 [`std::thread::scope`][thread_scope] 的思路。利用 invariant lifetime 构造了一个唯一的 ID。

```rust
type InvariantLifetime<'brand> = PhantomData<fn(&'brand ()) -> &'brand ()>;
pub struct ValuePerm<'brand> {
    _lifetime: InvariantLifetime<'brand>,
}
pub struct LruCache<'brand, K, V> {
    _lifetime: InvariantLifetime<'brand>,
    _marker: PhantomData<(K, V)>,
}
impl<'brand, K: Eq + Hash, V> LruCache<'brand, K, V> {
   // ...
}
pub fn new_lru_cache<K, V, F>(fun: F)
where
    F: for<'brand> FnOnce(ValuePerm<'brand>, LruCache<'brand, K, V>),
{
    let perm = ValuePerm {
        _lifetime: InvariantLifetime::default(),
    };
    let cache = LruCache::<K, V> {
        _lifetime: Default::default(),
        _marker: Default::default(),
    };
    fun(perm, cache);
}
```

我们移除了 `LruCache::new` 方法，强制通过 `new_lru_cache` 创造一个 scope，并且在 scope 内使用。`LruCache` 和 `ValuePerm` 共享一个唯一的生命周期作为 ID。

```rust
new_lru_cache(|mut perm, mut cache| {
    cache.put("a", "b".to_string(), &mut perm);
    cache.put("b", "c".to_string(), &mut perm);
    cache.put("c", "d".to_string(), &mut perm);
    let x = cache.get(&"a").unwrap().as_str();
    let y = cache.get(&"b").unwrap().as_str();
    let z = cache.get(&"c").unwrap().as_str();
    [x, y, z].join(" ");
});
```

实现到这里的时候，我发现我忘了一个非常致命的问题，我可以修改所有的方法来接受 `&mut Perm`，但没法修改 `Drop` ，这可能导致 `cache` 早于 `&V` 被释放。而使用 `'cache: 'perm` 作为 constraint 会导致 `&V` 再次被 `&'cache mut self` 限制。

```rust
new_lru_cache(|mut perm, mut cache| {
    cache.put("a", "b".to_string(), &mut perm);
    cache.put("b", "c".to_string(), &mut perm);
    cache.put("c", "d".to_string(), &mut perm);
    let x = cache.get(&"a").unwrap().as_str();
    let y = cache.get(&"b").unwrap().as_str();
    let z = cache.get(&"c").unwrap().as_str();
    drop(cache);
    [x, y, z].join(" "); // Boom
});
```

如果 Rust 有 [linear type][linear_type] 支持的话，我们可以阻止 `LruCache` 被 drop，必须通过类似 `consume(self, &mut ValuePerm)` 之类的方法来销毁，很遗憾的是 linear type 属于有生之年系列，因此我这里用了另一个 workaround：

```rust
pub fn new_lru_cache<K, V, F>(fun: F)
where
    F: for<'brand> FnOnce(ValuePerm<'brand>, LruCache<'brand, K, V>) -> (ValuePerm<'brand, LruCache<'brand, K, V>>),
```

这里要求 `new_lru_cache` 接受的回调必须将 `perm` 和 `value` 的所有权返回再统一 drop。由于 `'brand` 的唯一性，回调必须将变量返回而无法提前销毁。

```rust
new_lru_cache(|mut perm, mut cache| {
    cache.put("a", "b".to_string(), &mut perm);
    cache.put("b", "c".to_string(), &mut perm);
    cache.put("c", "d".to_string(), &mut perm);
    let x = cache.get(&"a").unwrap().as_str();
    let y = cache.get(&"b").unwrap().as_str();
    let z = cache.get(&"c").unwrap().as_str();
    [x, y, z].join(" ");
    
    (perm, cache)
});
```

至此我们的接口设计就大功告成了，具体实现几乎可以完全从 [lru][lru-rs] copy，反正 unsafe 可以操纵一切，我们只要保证上层接口足够安全就行。

我实现了一个简单的完整可用版本，开源在 <https://github.com/TennyZhuang/ref-stable-lru>，并且已经发布到 crates.io [ref-stable-lru](https://crates.io/crates/ref-stable-lru)，感兴趣的可以试玩一下，特别是提出一些 unsound 的宝贵意见。

## Reference Stability in C++ STL

熟悉 C++ 的朋友都知道，C++ STL 有一个非常黑暗的概念，叫 reference/iterator stability，或者叫 reference/iterator invalidation。在 [cppreference][cppreference_container_stability] 中，我们可以找到这样一张图，它描述了各个 containers 在各种操作下的行为。

![cpp references/iterators invalidation](https://s2.loli.net/2024/01/26/N8jMQfDwR3KsUqH.png)

这个 feature 是 C++ UB 的重灾区之一，主要原因是只在 doc 里提到，完全没法在签名上约束。而 Rust 完全阻止了相关的行为，Rust 标准库的所有 collection，只要你持有任何一个 reference，你都无法对这个结构进行任何操作，这其实浪费了 collection 的很多特性。这篇文章的设计思路是将 collection 的操作权限分散到各个 Perm 上，从而提供细粒度的读写权限控制，这个思想高度借鉴了 [Ghost Cell][ghost_cell]。用类似的思路，我们也可以实现一些其他常用的数据结构，例如持有引用的同时可以 push 的 `VecDeque`。

[cppreference_container_stability]: https://en.cppreference.com/w/cpp/container#Iterator_invalidation
[lru-rs]:https://crates.io/crates/lru
[linear_type]:https://blog.yoshuawuyts.com/linearity-and-control/
[ghost_cell]:https://crates.io/crates/ghost-cell
[thread_scope]:https://doc.rust-lang.org/std/thread/fn.scope.html
