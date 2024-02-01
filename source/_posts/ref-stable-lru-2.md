---
title: Design a collection with compile-time reference stability in Rust (2)
date: 2024-01-31 18:00:00
tags:
- Programming
- Rust
---

在[上一篇文章](https://blog.zhuangty.com/ref-stable-lru/)中，我们设计了一个允许同时持有多个不可变引用的 `LruCache`。唯一的问题是，为了足够安全，API 不太易用。这篇文章完美地解决了问题。

```rust
new_lru_cache(|mut perm, mut cache| {
    cache.put("a", "b".to_string(), &mut perm);
    cache.put("b", "c".to_string(), &mut perm);
    cache.put("c", "d".to_string(), &mut perm);
    let x = cache.get(&"a", &perm).unwrap().as_str();
    let y = cache.get(&"b", &perm).unwrap().as_str();
    let z = cache.get(&"c", &perm).unwrap().as_str();
    [x, y, z].join(" ");

    (perm, cache)
});
```

这里的主要问题是，`LruCache` 必须通过一个 closure 创建，且携带了一个 `'brand` 生命周期，如果想存在某个 ADT 里，会将生命周期泛型向上传染。

在我的朋友的提示下，我发现我们可以将 `LruCache` 的数据和对它的操作分离，为此，我设计了一套新的 [scope API](https://github.com/TennyZhuang/ref-stable-lru/pull/1/files)。

首先，在原本的代码之上，我们将 `'brand` 从 `LruCache` 上删除，然后引入一个新的结构体 `CacheHandle`：

```rust
pub struct LruCache<K, V> {
    _marker: PhantomData<(K, V)>,
}
pub struct CacheHandle<'cache, 'brand, K, V> {
    _lifetime: InvariantLifetime<'brand>,
    cache: &'cache mut LruCache<K, V>,
}
```

很显然，`LruCache` 可以通过常规的方式构建：

```rust
impl LruCache {
    pub fn new(cap: usize) -> Self { todo!() }
}
```

这里 `CacheHandle` 替代了我们上一篇文章中 `LruCache` 的职责，需要与 `ValuePerm` 深度绑定，为此我们引入了 `LruCache::scope` API，替代了原来的 `new_lru_cache`。

```rust
impl<K, V> LruCache<K, V>
    pub fn scope<'cache, F, R>(&'cache mut self, fun: F) -> R
    where
        for<'brand> F: FnOnce(CacheHandle<'cache, 'brand, K, V>, ValuePerm<'brand>) -> R,
    {
        let handle = CacheHandle {
            _lifetime: Default::default(),
            cache: self.into(),
        };
        let perm = ValuePerm {
            _lifetime: InvariantLifetime::default(),
        };
        fun(handle, perm)
    }
}
```

这个函数接受的是 `&mut LruCache`，保证了同一时间只有一个 `handle`进行操作。

这里的回调签名 `for<'brand> F: FnOnce(CacheHandle<'cache, 'brand, K, V>, ValuePerm<'brand>) -> R`，对比于上一篇文章，这里不再需要把 `handle` 和 `perm` 返回，因为 `CacheHandle::cache` 仅仅是对 `LruCache` 的可变引用，即使对 `handle` 提前 `drop`，scope 内对 value 的引用仍然是合法的。

我们将上一篇文章中的方法分别实现在 `CacheHandle` 上：

```rust
impl<'cache, 'brand, K: Hash + Eq, V> CacheHandle<'cache, 'brand, K, V> {
    pub fn put<'handle, 'perm>(
        &'handle mut self,
        k: K,
        mut v: V,
        _perm: &'perm mut ValuePerm<'brand>
    ) -> Option<V> { todo!() }
    pub fn get<'handle, 'perm>(
        &mut self,
        k: &K,
        _perm: &'perm ValuePerm<'brand>,
    ) -> Option<&'perm V> { todo!() }
    pub fn peek_mut<'handle, 'key, 'perm>(
        &'handle self,
        k: &'key K,
        _perm: &'perm mut ValuePerm<'brand>,
    ) -> Option<&'perm mut V> { todo!() }
}
```

这些 API 的正确性，上一篇文章已经论述过，这里不再重复，有了这些 API 以后，我们就可以这样用我们的 LruCache。

```rust
let mut cache = LruCache::new(2);
cache.scope(|mut cache, mut perm| {
    assert_eq!(cache.put("apple", "red", &mut perm), None);
    assert_eq!(cache.put("banana", "yellow", &mut perm), None);
    assert_eq!(cache.put("lemon", "yellow", &mut perm), Some("red"));
    let colors: Vec<_> = ["apple", "banana", "lemon", "watermelon"]
        .iter()
        .map(|k| cache.get(k, &perm))
        .collect();
    assert!(colors[0].is_none());
    assert_opt_eq(colors[1], "yellow");
    assert_opt_eq(colors[2], "yellow");
    assert!(colors[3].is_none());
});
```

由于 `cache` 现在是 Owned type，不借用任何生命周期，我们可以非常自由地将它存在任何地方。而只需要在修改的时候创建一个 scope 即可。

更近一步的，我们甚至可以将 `LruCache` 原来的方法添加回来，当我们不需要 reference stability 时，可以不需要引入额外的代码复杂度。

```rust
impl<K, V> LruCache<K, V> {
    pub fn put(&mut self, k: K, v: V) -> Option<V> {
        self.scope(|mut cache, mut perm| cache.put(k, v, &mut perm))
    }

    pub fn get<'cache>(&'cache mut self, k: &K) -> Option<&'cache V> {
        // SAFETY: We actually hold `&'cache mut self` here, so the only reference should always be valid.
        // We can extend its lifetime to the cache easily.
        self.scope(|mut cache, perm| unsafe {
            std::mem::transmute::<_, Option<&'cache V>>(cache.get(k, &perm))
        })
    }
}
```

我们可以像正常的 collection API 一样来使用它：

```rust
let mut cache = LruCache::new(2);
cache.put("apple", "red", &mut perm);
let data = cache.get("apple");
// We can't call `get` twice when `data` reference is still valid.
// cache.get("lemon");
dbg!(data);
```

## Conclusion

上一篇文章的末尾，我们提到了这套 API 较差的易用性可能限制了它的应用空间，那么这篇文章的改进在我看来，如果可以证明其 soundness，甚至达到了可以合并到标准库的程度（我会尝试给标准库的 `LinkedList`、`VecDeque` 等提 Reference Stability 的 RFC）。这个将数据和操作分离的 API 改进，我们只需要在原本的数据结构上单独添加一个 `scope` API，并且在对应的 closure 内遵循权限分离的设计。而在不需要 reference stability 的场景，我们不会引入任何额外的代码复杂度，真正地做到了 “pay as you needed”，这非常符合 Rust 的设计哲学。
