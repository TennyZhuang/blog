/**
 * Beautiful Mermaid Loader
 * 使用 beautiful-mermaid 渲染 mermaid 代码块
 */

(function() {
  'use strict';

  // 配置
  const config = {
    // CDN 地址
    cdnUrl: 'https://unpkg.com/beautiful-mermaid@0.1.3/dist/beautiful-mermaid.browser.global.js',
    // 主题配置（白色背景）
    theme: {
      bg: '#ffffff',      // 背景色（白色）
      fg: '#27272a',      // 前景色（深灰色文字）
      accent: '#3b82f6',  // 强调色（蓝色）
      line: '#d4d4d8',    // 线条颜色
      muted: '#71717a',   // 次要文字颜色
    }
  };

  // 加载脚本
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // 渲染单个 mermaid 图表
  async function renderDiagram(element, renderMermaid) {
    const code = element.textContent.trim();
    if (!code) return;

    try {
      // 获取代码块的父容器
      const preElement = element.closest('pre');
      const wrapper = preElement ? preElement.parentElement : element.parentElement;
      
      // 渲染 SVG
      const svg = await renderMermaid(code, config.theme);
      
      // 创建容器
      const container = document.createElement('div');
      container.className = 'beautiful-mermaid-container';
      container.style.cssText = `
        margin: 1rem 0;
        overflow-x: auto;
        text-align: center;
      `;
      container.innerHTML = svg;

      // 添加 SVG 样式
      const svgElement = container.querySelector('svg');
      if (svgElement) {
        svgElement.style.maxWidth = '100%';
        svgElement.style.height = 'auto';
      }

      // 替换原代码块
      if (preElement) {
        wrapper.replaceChild(container, preElement);
      } else {
        wrapper.replaceChild(container, element);
      }
    } catch (error) {
      console.error('Beautiful Mermaid render error:', error);
      // 渲染失败时保留原代码块，但添加错误提示
      const errorDiv = document.createElement('div');
      errorDiv.className = 'beautiful-mermaid-error';
      errorDiv.style.cssText = `
        padding: 1rem;
        margin: 1rem 0;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 0.375rem;
        color: #991b1b;
      `;
      errorDiv.textContent = 'Failed to render mermaid diagram: ' + error.message;
      
      const preElement = element.closest('pre');
      if (preElement && preElement.parentElement) {
        preElement.parentElement.insertBefore(errorDiv, preElement.nextSibling);
      }
    }
  }

  // 主函数
  async function init() {
    // 查找所有 mermaid 代码块（支持多种类名格式）
    const mermaidBlocks = document.querySelectorAll('.language-mermaid, .language-mermaidjs, code.mermaid');
    if (mermaidBlocks.length === 0) {
      console.log('Beautiful Mermaid: No mermaid blocks found');
      return;
    }

    console.log(`Beautiful Mermaid: Found ${mermaidBlocks.length} diagram(s)`);

    try {
      // 加载 beautiful-mermaid 库
      await loadScript(config.cdnUrl);
      
      // 检查库是否加载成功
      if (typeof beautifulMermaid === 'undefined' || !beautifulMermaid.renderMermaid) {
        console.error('Beautiful Mermaid library failed to load');
        return;
      }

      const { renderMermaid } = beautifulMermaid;

      // 渲染所有图表
      const promises = Array.from(mermaidBlocks).map(block => 
        renderDiagram(block, renderMermaid)
      );
      
      await Promise.all(promises);
      console.log(`Beautiful Mermaid: Rendered ${mermaidBlocks.length} diagram(s)`);
    } catch (error) {
      console.error('Beautiful Mermaid initialization error:', error);
    }
  }

  // 在 DOM 加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 注册 Fluid 主题的刷新回调（如果可用）
  if (typeof Fluid !== 'undefined' && Fluid.events && Fluid.events.registerRefreshCallback) {
    Fluid.events.registerRefreshCallback(init);
  }
})();
