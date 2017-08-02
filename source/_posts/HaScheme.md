---
title: HaScheme
date: 2017-01-18 23:41:03
tags:
- Programming
- Haskell
---

[HaScheme](https://github.com/TennyZhuang/HaScheme) 是用 Haskell 实现的 Scheme 解释器，作为 函数式编程语言课程的 Course Project, 应该是这学期最满意且收获最多的一个大作业了，得益于之前编译原理 Course Project [NaiveC](https://github.com/TennyZhuang/NaiveC) 踩了很多坑，对编译器/解释器前端相关的一些理论有了一些了解，在连肝五天以后基本完成了 Scheme 标准语法的大部分内容。

HaScheme 基于 Stack 构建了项目，如经典的解释器架构一样，将项目主要划分为了三个模块，`Lexer`，`Parser` 和 `Interpreter`，输入的 Scheme 代码首先通过 Lexer 转为 token 序列，然后通过 Parser 将 tokens 转换为 AST，最后由 Interpreter 解释 AST 执行。

HaScheme 参考了很多 [Write yourself a Scheme in 48 hours](https://en.wikibooks.org/wiki/Write_Yourself_a_Scheme_in_48_Hours) 这个教程的内容，这个教程非常初学者友好，不过这个教程实现的文法作用域有一些 bug。HaScheme 中修复了文法作用域的问题，并且扩展了语法特性。

<!-- more -->

## Lexer and Parser

Lexer 和 Parser 是写的最舒服的一部分了，主要是 ParseC 实在太好用了，可以用原生 Haskell 代码直接描绘语法生成式的结构，并通过 Parser Monad 很轻松的转换为想要的数据结构。

ParseC 是自顶向下分析的，遇到不匹配的情况需要用 `try` 回溯，比较遗憾的是对于需要回溯的情况，ParseC 无法正确地输出报错信息，对于这部分我也没有特别处理，所以 Parser 的报错系统非常简陋。

## 文法作用域的实现

Haskell 原生的数据结构就是 AST 的形式，配合 Pattern Match 解释起来简直爽到起飞，不过 Immutable 的特性就不那么令人愉快了，应该是我姿势水平不足的缘故，不少操作（如 `define`，`set!`）在解释的过程中是会对环境造成影响的，一开始我尝试用 State Monad 来实现环境，大概思路是

```Haskell
import Control.Monad.State

schemeDefineVar :: String -> SchemeValue -> State Environment ()
```

不过这样的话，非常困扰于文法作用域的实现，因为对于一个作用域，必须能引用父级作用域的中的变量，也可以支持 Variable Shadowing 而不对父级作用域造成影响。

最终的实现参考了教程，即基于 `Data.IORef` 来实现变量。

```Haskell
import Data.Map
import Data.IORef

type Environment = IORef (Map String (IORef SchemeValue))
```

等于在命令式语言中保存了变量实体的指针，这样在新建一个子级作用域的时候，可以简单的拷贝当前环境，子级作用域也能对当前环境的变量进行读写，同时在新增变量时只对新的环境进行修改而不影响父级作用域的环境。

这部分就是[教程](https://en.wikibooks.org/wiki/Write_Yourself_a_Scheme_in_48_Hours/Adding_Variables_and_Assignment)实现错误的地方，教程中，对于 `define` 一个同名变量

```Haskell
defineVar :: Env -> String -> LispVal -> IOThrowsError LispVal
defineVar envRef var value = do
     alreadyDefined <- liftIO $ isBound envRef var
     if alreadyDefined
        then setVar envRef var value >> return value
        else liftIO $ do
             valueRef <- newIORef value
             env <- readIORef envRef
             writeIORef envRef ((var, valueRef) : env)
             return value
```
他会简单的修改修改变量的值为新的值，这回导致对父级作用域的变量进行修改，而这时候正确的行为是掩蔽父级作用域的同名变量，即新建一个 `IORef` 替换当前的 `IORef` 而非修改当前的 IORef。

教程中的实现会产生如下 bug

```Scheme
(define (f x y)
  (+ ((lambda (x)
    (+ x 1)) y) x)

(f 2 4)
```

正确的输出应该是 7，然而执行的结果却是 9，因为嵌套内部的函数参数 x 修改了外部 x 的值。

在我的实现中

```Haskell
defineVar :: Environment -> String -> SchemeValue -> IOThrowsError SchemeValue
defineVar envRef varname val = do
  env <- liftIO $ readIORef envRef
  liftIO $ do
    valRef <- newIORef val
    writeIORef envRef (Map.insert varname valRef env)
    return val
```

删去了变量是否存在的判断，一律插入新的 `IORef`，修复了这个 bug。

## 命令式语言特性的实现

Haskell 是支持一部分命令式的语法的，所以我实现了 `begin` 语句 和 `while` 语句，不过在我的实现方法中很难正确的实现 `while` 语句，所以我用了一个很 Hack 的实现，在 Parser 的阶段将 `while` 语句 parse 成 `if` 语句和 尾递归调用的语法糖，这种实现有很多问题比如栈溢出等，所以其实没有正确实现这个特性。

```Haskell
parseWhile :: Parser Expr
parseWhile = do
  char '('
  reserved "while"
  spaces
  cond <- parseExpr
  spaces
  body <- parseExpr
  char ')'
  return . BeginExpr $ ListExpr [
    DefineVarExpr "`whilerec" (
      LambdaFuncExpr [] (
        IfExpr cond (BeginExpr $ ListExpr [
          body,
          FuncCallExpr (SymbolExpr "`whilerec") (ListExpr [])
        ]) cond)
    ),
    FuncCallExpr (SymbolExpr "`whilerec") (ListExpr [])]
```

## REPL

没有 REPL 的解释器是不完整的，这里非常感谢 [Haskeline](http://hackage.haskell.org/package/haskeline) 的作者，借助 Haskeline 强大的 API，实现了很好用的 REPL。

![repl](http://7xleha.com1.z0.glb.clouddn.com/repl.gif)

实现了历史记录、自动补全、语法树查看等特性。
