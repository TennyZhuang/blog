---
title: 五一摸鱼周记：更新 Blog 主题、水 PR
date: 2021-05-06 13:09:06
tags:
  - Blog
  - Water
---

灌水一篇，这篇文章会介绍：

* 更新Blog主题的**底层逻辑**
* 利用 vercel serverless **赋能** blog 的 slogan
* 打好 hexo-fluid-theme 和 cusdis 的**组合拳**
* **反哺** cusdis 的生态

🐶狗头保命

<!-- more -->



更新 blog 主题是一个比写 blog 文章快乐多了的事情，这也是 blog 新手常常陷入的一个陷阱 —— 精心配置一整天的主题、评论、评论、插件，然后写下一篇 类似于 Hello World 的《使用XXX 搭建 blog》之后从此吃灰。为了避免自己陷入这个陷阱，我搭 blog 的时候给自己定下了一个规则 —— **每次写一篇文章才能更新一次与文章无关的 blog 配置**。

最终的结果是 —— 我既没有保持合适的更新频率，也没机会折腾主题，直接使用了烂大街的 [hexo next](https://github.com/theme-next/hexo-theme-next)，没有评论，没有 Analytics，甚至连 Hello World 都没写，创造了一个三无 blog。

直到今年开始，我成功更新了两篇文章（这里非常感谢  [Taio App](https://taio.app)，让我在手机上也能快乐地写 blog），适当地让 blog 更易用一些也提上了日程

第一件事情自然是喜闻乐见的换皮，选了 
[hexo-fluid-theme](https://github.com/fluid-dev/hexo-theme-fluid)，就觉得挺好看的，配置也比较完善，代码也不复杂，看了看感觉如果有必要的话（其实很快就有必要了），我自己也改得动。

配置的过程中，遇到了两个麻烦，一个是这个主题必须配置一个 banner_img，而且默认的太丑了，于是为了提高辨识度，我随手画了一个更丑的，以后有机会再优化（下次一定）。另一个是主页上要求写一个 slogan，我想把 [迟语录 chi_corpus](https://github.com/TennyZhuang/Chi-Corpus) 随机显示在主页上，但是 hexo-fluid-theme 只支持 json 格式，即使我 commit 一个 json 格式上去，也没法做到随机返回，独立维护一个转换服务又会极大增加我的运维负担，因此动了薅 vercel 羊毛的心思。翻了翻 [vercel serverless](https://vercel.com/docs/serverless-functions/introduction) 的使用文档，感觉使用起来非常简单，而事实上也是如此。仅仅是花了五分钟，添加一个四十行的 go 文件，我就轻松达到了我的目的。赞美 vercel（*1）！

```go
const CHI_CORPUS_URL = "https://raw.githubusercontent.com/TennyZhuang/Chi-Corpus/master/common.txt"



type Data struct {

	Content string `json:"content"`

}



func fetchChiCorpus() (*Data, error) {
	resp, err := http.Get(CHI_CORPUS_URL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	content := string(body)
	lines := strings.Split(content, "\n")
	line := lines[rand.Intn(len(lines))]
	return &Data{
		Content: line,
	}, nil
}

func Handler(w http.ResponseWriter, r *http.Request) {
	data, err := fetchChiCorpus()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(err.Error()))
	} else {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(data)
	}
}
```

本来鸽子博主已经决定更新到这里结束了，看了推友 [@frostming90](https://twitter.com/frostming90?s=21) 的 [blog](https://frostming.com/2021/04-28/self-host-comment-system/)（别人的 blog 真好看啊），于是进行了一番抄作业。再吹一次，vercel 真的好用（*2），无脑就把一个 blog 后台跑起来了，而且还是白嫖。这次遇到一个新问题，就是 hexo-fluid-theme 支持了许多 comment plugin，但还不支持 cusdis。顺手 fork 了一个支持了一下，顺便提了个 PR <https://github.com/fluid-dev/hexo-theme-fluid/pull/474>。目前 console 里还有个奇妙的报错 `Function called outside component initialization`，但似乎不影响 plugin 的使用，有知道怎么修的也可以带带我，前端技能不太熟练了：（

目前对 cusdis 还有一些小小的问题，比如评论仅支持审核后显示，似乎不支持默认显示的方式，使用起来比较麻烦，后续考虑 contribute 一下。欢迎试用新整的评论系统～

个人搭建并维护 blog 还是比较麻烦的事情，一个关键技巧是在**掌控数据**的前提下尽可能依赖第三方服务。这次的整套组合拳打下来基本也就花了半天的时间在折腾（没有 vercel 可能一天起步了，点赞*3），但数据是以可以掌控的格式（postgresql，可以自己备份）存储的。考虑到 [Donald Trump 被封禁到搭建了自己的个人博客](https://www.45office.com)，可见 blog 这种去中心化的组织形式还是有必要的。
