---
title: CPython 源码（一）： PyObject
date: 2017-07-30 21:56:06
tags: 
  - Python
  - Source Code
---

## 前言

这是 CPython 源码阅读系列的第一篇，我也不知道能坚持多久，或许连这篇都写不完（如果你能在网上看到这句话，说明至少第一篇写完了）。

Python 是一门非常强大的动态语言，语法特性多且优美，非常符合人类直觉，是我最喜欢的语言之一，再加上 CPython 做的优化非常少（笑），不像某些 JS 引擎如 V8，为了性能各种 hack 技巧太多不适合阅读学习。

[CPython 源码链接](https://github.com/python/cpython)

对 Python 比较精通以后，自然而然会产生疑问，那么强大的 Python，是怎么通过一门语法特性非常少的静态语言 C 来实现的呢？

<del>当然，阅读 CPython 源码的第一步，就是让你抛弃 C 语言是静态类型的错觉。</del>

本系列无明显顺序，更类似于个人阅读中的笔记，可能有错误，欢迎指出。

本系列文章要求阅读者：

* 了解 C 语言的特性，特别是强制转换时的行为
* 了解 Python 语言本身的基本行为和高级特性

<!-- more -->

作者开始阅读源码时，使用的 Python 版本是 `Python 3.7.0a0`，最新的 commit 号为 `984eef7d6d78e1213d6ea99897343a5059a07c59`。

本文涉及的核心文件是

* [Include/object.h](https://github.com/python/cpython/blob/master/Include/object.h)
* [Objects/object.c](https://github.com/python/cpython/blob/master/Objects/object.c)

## PyObject

一切都要从 Hello World 开始，CPython 源码阅读的 Hello World，当然是从 `PyObject` 开始。

首先，在 `object.h` 里找到 `PyObject` 的定义：

```c
typedef struct _object {
    _PyObject_HEAD_EXTRA
    Py_ssize_t ob_refcnt;
    struct _typeobject *ob_type;
} PyObject;
```

Python 中的一切对象，都至少保存了以上属性，这也是为什么在 Python 中，哪怕是一个简单的 `0`，也比 C 语言占用了更多内存的原因。

`_PyObject_HEAD_EXTRA` 这个宏是全空的，应该是为了未来可能的修改而保留修改空间，可以先忽略它。

观察一下 `ob_refcnt` 和 `ob_type`。

## 引用计数

Python 是一门自带 GC 的语言，而 Python 的 GC 是以引用计数机制为主的，`ob_refcnt` 保存了 Python 每个对象被引用的次数。

在 `object.c` 中实现了一个函数 `Py_IncRef`，这个是暴露给 Python runtime embedders 的管理 `PyObject` 引用计数的接口，而源码内部的实现基本调用的是 `Py_XINCREF`（附录 0） 和 `Py_INCREF` 这两个宏。

```c
/* Macros to use in case the object pointer may be NULL: */
#define Py_XINCREF(op)                                \
    do {                                              \
        PyObject *_py_xincref_tmp = (PyObject *)(op); \
        if (_py_xincref_tmp != NULL)                  \
            Py_INCREF(_py_xincref_tmp);               \
    } while (0)

#define Py_INCREF(op) (                         \
    _Py_INC_REFTOTAL  _Py_REF_DEBUG_COMMA       \
    ((PyObject *)(op))->ob_refcnt++)
```

我们先假装没看到一系列的强制转换，那么这两个宏的作用就分别是 safe 和 unsafe 地增加一个 PyObject 的引用计数。

关于 `ob_refcount` 还定义了一些别的宏，具体的运用方式想放在 GC 的章节一起看。

`ob_refcount` 的类型是 `Py_ssize_t`，这个类型在我的系统上等价于 `long`，再加上为了为了效率，维护引用计数的时候显然不会作边界检查，这就意味着如果你的一个对象引用超过 `LONG_MAX` 的话应该会溢出，然而虽然很想尝试一下，但我并不知道怎么在爆 Memory Overflow 前让一个对象的引用计数超过 `long`。

## PyVarObject

`ob_type` 显然保存着对象的类型信息，然而在观察其具体实现之前，我们可以看一下紧跟着 `PyObject` 的另一个结构体的定义，`PyVarObject`。

根据注释，`PyVarObject` 用来存储变长的 python 对象（如 list 等），熟悉 C++ 的同学可能已经忍不住脑补出以下代码：

```cpp
// fake PyVarObject
class PyVarObject : public PyObject {
public:
    Py_ssize_t ob_size;
};
```

那我们再来看它在 CPython 中的实现：

```c
typedef struct {
    PyObject ob_base;
    Py_ssize_t ob_size; /* Number of items in variable part */
} PyVarObject;
```

看起来非常反人类的做法，难道每次想操作 PyVarObject 中 `ob_type` 的时候都要多一层 `ob_base` 吗？

然后就是一个比较神奇的操作，而且唯有 C 这种结构体严格映射内存结构的语言才能做到（附录 1），对于 C 来说，`PyObject ob_base;` 的内存结构和 `_PyObject_HEAD_EXTRA Py_ssize_t ob_refcnt; struct _typeobject *ob_type;` 是完全等价的，那么可以直接把 `PyVarObject*` 类型的对象强制转换成 `PyObject*` 类型的对象，然后直接当成 PyObject* 类型操作。

![内存结构图](https://i.loli.net/2017/07/30/597dff20cbd40.png)

现在我们可以回过去看代码中对于 `PyObject` 某段注释：

> Nothing is actually declared to be a PyObject, but every pointer to
> a Python object can be cast to a PyObject*.  This is inheritance built
> by hand.  Similarly every pointer to a variable-size Python object can,
> in addition, be cast to PyVarObject*.

`PyObject` 不是 Python 中的任何一种类型，但是任何任何 Python 对象的指针都能被 cast 成 `PyObject*`，相当于手动实现了继承（附录 2）。同理如 `PyVarObject*`。

为了方便之后 Python 中对象的定义，object.h 中定义了两个宏

```c
#define PyObject_HEAD                   PyObject ob_base;
#define PyObject_VAR_HEAD      PyVarObject ob_base;
```

利用这两个宏来达到继承 `PyObject` 和 `PyVarObject` 的作用。

（看到这里，你可以再思考一下 C 究竟是不是静态语言，至少有没有被人当静态语言用）

## PyTypeObject

Python 中一切皆为对象，类型也不例外。

现在让我们回到被我们跳过的 `ob_type`，这是一个指向 `PyTypeObject` 对象的指针。

```c
typedef struct _typeobject {
    PyObject_VAR_HEAD
    const char *tp_name; /* For printing, in format "<module>.<name>" */
    Py_ssize_t tp_basicsize, tp_itemsize; /* For allocation */
    
    // ...
};
```

`PyTypeObject` 继承了 `PyVarObject`，这个对象非常的复杂，在之后的文章再详细介绍。

## 附录

[0]: 关于 `do ... while(0)` 的[解释](http://www.bruceblinn.com/linuxinfo/DoWhile.html)，之后的贴代码的时候可能会省略该部分。

[1]: 参见 https://stackoverflow.com/questions/2748995/c-struct-memory-layout

[2]: 虽然 C 语言里没有继承的语法，不过这个概念完全是继承，再加上作者钦定了，所以之后将直接用「继承了 `PyObject`」 这种语言来描述这种行为。
