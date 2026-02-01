---
title: Beautiful Mermaid 测试
hide: true
date: 2026-02-01 21:00:00
tags:
  - test
  - mermaid
---

# Beautiful Mermaid 渲染测试

这是一篇隐藏文章，用于测试 beautiful-mermaid 是否正确渲染 Mermaid 图表。

## 流程图 (Flowchart)

```mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process 1]
    B -->|No| D[Process 2]
    C --> E[End]
    D --> E
```

## 状态图 (State Diagram)

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing: start
    Processing --> Complete: done
    Processing --> Error: fail
    Complete --> [*]
    Error --> Idle: retry
```

## 序列图 (Sequence Diagram)

```mermaid
sequenceDiagram
    participant User
    participant System
    participant Database
    
    User->>System: Request data
    System->>Database: Query
    Database-->>System: Return results
    System-->>User: Display data
```

## 类图 (Class Diagram)

```mermaid
classDiagram
    Animal <|-- Duck
    Animal <|-- Fish
    
    class Animal {
        +int age
        +String gender
        +isMammal()
    }
    
    class Duck {
        +String beakColor
        +swim()
        +quack()
    }
    
    class Fish {
        -int sizeInFeet
        -canEat()
    }
```

## ER 图 (Entity Relationship)

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "is in"
    
    CUSTOMER {
        string name
        string email
    }
    
    ORDER {
        int order_id
        date created_at
    }
    
    PRODUCT {
        int product_id
        string name
        float price
    }
```

---

如果以上图表都被正确渲染为美观的 SVG，说明 beautiful-mermaid 集成成功！
