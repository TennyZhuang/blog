---
title: gogo/protobuf 的一个性能 bug
date: 2020-02-03 20:17:06
tags:
- Programming
- Golang
- Protobuf
- Bug
---

源码阅读笔记是不可能续写的，这辈子都不可能续写的，paper notes 也是几年也不会更新一篇的，还不如把博客随便当个笔记本记录点遇到过的有意思的问题好了。

Protobuf 是 Google 整的一个序列化/反序列化框架，性能不算很好不过用的人比较多，各个语言的实现也比较全，其中 golang 的版本是 google 官方维护的 [golang/protobuf](https://github.com/golang/protobuf)，但由于比较保守，对各种新 feature request 不太感兴趣，所以社区广泛使用的是一个 fork 的版本 [gogo/protobuf](https://github.com/gogo/protobuf)，gogo 版本不仅在性能上做了很多优化，而且提供了很多 [extensions](https://github.com/gogo/protobuf/blob/master/extensions.md)，可以让生成的代码更符合 go 开发的习惯。

这篇 blog 记录的是在使用 stdtime extension 中遇到的一个性能问题排查过程和修复方案。stdtime extension 可以把 Google 提供的一个公共库中 Timestamp 的类型定义转化为 golang 标准库 `time.Time` 的定义。

<!-- more -->

线上开发某个服务的时候用了 gRPC 和 gogo/protobuf，然后其中的 message 定义大概是：

```protobuf
import "github.com/gogo/protobuf/gogoproto/gogo.proto";
import "google/protobuf/timestamp.proto";

message A {
    // ...
    google.protobuf.Timestamp created_at = 1 [(gogoproto.stdtime) = true];
}

message B {
    repeated A as = 1;
}

message Empty {}

service S {
    rpc RPC (Empty) returns (B) {}
}
```

大概有几千个服务会调这个 RPC，每次返回的 as 的长度大约是 10000 左右。在测试时，从客户端观察，几乎每个请求都要耗时 20 秒以上，但在服务端观察到每个请求的处理时间在 100ms 以下。在排除了网络故障的可能性以后，我开始怀疑是 RPC Framework 的问题。

Golang 自带的 profile 框架 `pprof` 是非常好用的，简单跑了个 mutex profile 以后，观察到

![image.png](https://user-images.githubusercontent.com/9161438/115694530-89105100-a393-11eb-85dd-48ba13257e1b.png)

发现阻塞时间基本在 proto 包里的一个 `Mutex` 上。

简单翻了一下[代码](https://github.com/golang/protobuf/blob/d23c5127dc24889085f8ccea5c9d560a57a879d8/proto/table_marshal.go#L98-L110)

```go
var (
	marshalInfoMap  = map[reflect.Type]*marshalInfo{}
	marshalInfoLock sync.Mutex
)

// getMarshalInfo returns the information to marshal a given type of message.
// The info it returns may not necessarily initialized.
// t is the type of the message (NOT the pointer to it).
func getMarshalInfo(t reflect.Type) *marshalInfo {
	marshalInfoLock.Lock()
	u, ok := marshalInfoMap[t]
	if !ok {
		u = &marshalInfo{typ: t}
		marshalInfoMap[t] = u
	}
	marshalInfoLock.Unlock()
	return u
}
```

看起来是为了让每个 Message Type 都只会产生一个 `*marshalInfo`，用了一个全局的 map 和一个全局的 Mutex 来保护。产生大量 message 的时候，这个 Mutex 成为了瓶颈。这段代码在 gogo/protobuf 和 golang/protobuf 同时存在。

当时觉得已经定位到了问题，并且修复方案也很简单，用 RWMutex 做个 double check 就好了，测试过优化明显后，顺手给 golang/protobuf 交了一个 [PR](https://github.com/golang/protobuf/pull/1004)。

很不幸的是 golang/protobuf 的 maintainer argue 这个函数只会被调用少数次，有几个 message 定义就回被调用几次，与运行时产生的 message 数量无关。并且给出了复现例子，于是只好继续深入定位问题。

在 demo 中做了若干次详细的试验以后，发现这个 bug 确实只能用 gogo/protobuf 复现，并且必须打开 `[(gogoproto.stdtime) = true]` 的选项才会产生。

在打开这个特性开关后，gogo/protobuf 需要引用 google `Timestamp` 的定义来反序列化数据，再转化为 `time.Time`，`Timestamp` 的定义是由 protoc-gen-gogo 生成的，包路径为 `github.com/gogo/protobuf/types`，然而所有生成的代码都需要反过来依赖 `github.com/gogo/protobuf/proto`，所以会形成循环依赖。为了解决这个问题，gogo/protobuf 在 `github.com/gogo/protobuf/proto` 包里 mock 了一个 [timestamp](https://github.com/gogo/protobuf/blob/5628607bb4c51c3157aacc3a50f0ab707582b805/proto/timestamp_gogo.go#L38-L46)，只通过 struct tag 定义了最基本的序列化格式，而缺失了一些关键的方法，导致没有满足 `newMarshaler` 和 `Marshaler` 的 interface，同时 protobuf 为了满足向后兼容性，入口函数 [Marshal](https://github.com/gogo/protobuf/blob/5628607bb4c51c3157aacc3a50f0ab707582b805/proto/table_marshal.go#L2936-L2955) 依然接受不满足 `newMarshaler`，`Marshaler` 的参数，只是走了最慢的路径。

```go
func Marshal(pb Message) ([]byte, error) {
	if m, ok := pb.(newMarshaler); ok {
		siz := m.XXX_Size()
		b := make([]byte, 0, siz)
		return m.XXX_Marshal(b, false)
	}
	if m, ok := pb.(Marshaler); ok {
		// If the message can marshal itself, let it do it, for compatibility.
		// NOTE: This is not efficient.
		return m.Marshal()
	}
	// in case somehow we didn't generate the wrapper
	if pb == nil {
		return nil, ErrNil
	}
	var info InternalMessageInfo
	siz := info.Size(pb)
	b := make([]byte, 0, siz)
	return info.Marshal(b, pb, false)
}
```

由于同时涉及了代码生成和循环依赖问题，这个问题的正确修复方式可能需要涉及到很大的重构，比较简单的 Workaround 有：

* 使用 RWMutex 来优化这个全局 map，目前[我 fork 的版本](https://github.com/TennyZhuang/protobuf)就是这么干的。
* 在 `github.com/gogo/protobuf/proto` 中依赖 `github.com/golang/protobuf/ptypes` 中的 `Timestamp` 来避免循环依赖，但会导致 gogo/protobuf 依赖 golang/protobuf，仍然不是好的解决方案。
* 从生成的 `github.com/gogo/protobuf/types.Timestamp` 中 copy 更多代码到 mock 的 `github.com/gogo/protobuf/proto.timestamp` 中

目前提了一个 [issue](https://github.com/gogo/protobuf/issues/656)，不过 gogo/protobuf 的维护也不太活跃，在这个 issue 解决之前，建议不使用可能会触发该 bug 的 stdtime，stdduration，customtype 等 extension。
