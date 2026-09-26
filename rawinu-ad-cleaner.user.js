// ==UserScript==
// @name         RawINU 广告清理与规则记忆
// @namespace    local.rawinu.ad-cleaner
// @version      1.0.2
// @homepageURL  https://github.com/garyseesee/userscripts
// @supportURL   https://github.com/garyseesee/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/garyseesee/userscripts/main/rawinu-ad-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/garyseesee/userscripts/main/rawinu-ad-cleaner.user.js
// @description  清理广告框、限制广告弹窗；点选漏网广告后记住规则，支持撤销和暂停。
// @match        *://rawinu.com/*
// @match        *://*.rawinu.com/*
// @run-at       document-start
// @sandbox      JavaScript
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  // 这是页面清理脚本，不是浏览器网络过滤器。删除 script 不能撤销已经执行的代码。
  // 不在运行时加载远程代码或上传浏览记录；新版由 Tampermonkey 按更新设置下载。
  // 只保存当前主机的用户设置和点选规则。
  const VERSION = '1.0.2';
  const KEY = `rawinu-cleaner:v1:${location.hostname}`;
  const MARK = 'data-rawinu-cleaner-hidden';
  const UI = 'rawinu-ad-cleaner-ui';
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const defaults = { enabled: true, strictPopups: true, rules: [] };
  let saved;
  try { saved = GM_getValue(KEY, defaults); } catch { saved = defaults; }
  const config = {
    enabled: saved?.enabled !== false,
    strictPopups: saved?.strictPopups !== false,
    rules: Array.isArray(saved?.rules) ? saved.rules.filter(validRule).slice(-100) : [],
  };

  // 前五项来自 2026-09-26 检查的 RawINU 章节页；完整主机边界匹配。
  const AD_HOSTS = [
    'arsonojuncoes.com', 'nuancedmorosis.com', 'olivedrawer.com',
    'cabretpardao.com', 'zipcrypticbroadsheet.com',
    'doubleclick.net', 'googlesyndication.com', 'adsterra.com',
    'popads.net', 'popcash.net', 'exoclick.com',
  ];
  const BUILTIN = [
    // 当前三路广告脚本共用的悬浮层根节点；包含通知、宝箱、礼物及插屏。
    '[data-shb="1"]',
    '.ad-sandbox-container', 'ins.adsbygoogle', '[data-ad-slot]',
    '[id^="google_ads_iframe"]', '[id^="div-gpt-ad"]',
    '.ad-container', '.ad-slot', '.advertisement',
  ];
  const PROTECTED = 'html,body,head,main,nav,header,footer,form,#chapter-images,.chapter-content,.chapter-img,.img-wrapper';
  const CANDIDATES = [...BUILTIN, 'iframe', 'img[src]', 'img[data-src]', 'a[href]'].join(',');
  const hidden = new Map();
  const frameStates = new Map();
  const temporary = new Set();
  const events = [];
  const pending = new Set();
  let timer = null, host, shadow, statusNode, details, hint, frame, shield;
  let hiddenStyle, pick = null, popupCount = 0, rejectedLinks = 0, popupHookOK = false;
  let expanded = false, lastDirectLink = null;

  function validRule(rule) {
    if (!rule || !['selector', 'resource'].includes(rule.kind)) return false;
    if (typeof rule.value !== 'string' || rule.value.length > 1500) return false;
    if (rule.path !== null && typeof rule.path !== 'string') return false;
    if (rule.kind === 'resource') return ['img', 'iframe', 'a'].includes(rule.tag);
    try { document.querySelector(rule.value); return true; } catch { return false; }
  }
  function persist() {
    try { GM_setValue(KEY, config); }
    catch { tell('保存失败：本次生效，但关闭页面后可能丢失。'); }
    updateUI();
  }
  function log(kind, detail) {
    events.push({ kind, detail: String(detail).slice(0, 200), time: new Date().toISOString() });
    if (events.length > 80) events.shift();
  }
  function urlOf(raw) {
    try { return new URL(raw, location.href); } catch { return null; }
  }
  function isAdURL(raw) {
    const u = urlOf(raw);
    return !!u && AD_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  }
  function resourceKey(raw) {
    const u = urlOf(raw);
    return u && /^https?:$/.test(u.protocol) ? u.origin + u.pathname : null;
  }
  function resourceOf(el) {
    if (frameStates.has(el)) return frameStates.get(el).src;
    return el.getAttribute('data-src') || el.getAttribute(el.localName === 'a' ? 'href' : 'src');
  }
  function own(el) { return el === host || host?.contains(el) || el === hiddenStyle; }
  function protectedElement(el) {
    return own(el) || el.matches(PROTECTED) || !!el.querySelector(PROTECTED);
  }
  function activeRule(rule) { return rule.path === null || rule.path === location.pathname; }
  function ruleMatches(el, rule) {
    if (!activeRule(rule)) return false;
    if (rule.kind === 'selector') {
      try { return el.matches(rule.value); } catch { return false; }
    }
    return el.localName === rule.tag && resourceKey(resourceOf(el)) === rule.value;
  }
  function reasonFor(el) {
    if (protectedElement(el)) return null;
    if (temporary.has(el)) return '本页临时选择';
    if (el.matches(BUILTIN.join(','))) return '广告容器';
    if (['iframe', 'img', 'a'].includes(el.localName) && resourceOf(el) && isAdURL(resourceOf(el))) return '已知广告来源';
    const srcdoc = frameStates.has(el) ? frameStates.get(el).srcdoc : el.getAttribute('srcdoc');
    if (el.localName === 'iframe' && srcdoc) {
      // 只检查嵌入 HTML 的实际资源 URL，不因正文提到域名就误判。
      const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
      if ([...doc.querySelectorAll('script[src],iframe[src],img[src]')].some(n => isAdURL(n.getAttribute('src')))) return '内嵌广告框';
    }
    if (config.rules.some(rule => ruleMatches(el, rule))) return '你保存的规则';
    return null;
  }
  function hide(el, reason) {
    if (!hidden.has(el)) {
      hidden.set(el, { display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display'), marker: el.getAttribute(MARK) });
      log('隐藏', reason);
    }
    if (el.getAttribute(MARK) !== '1') el.setAttribute(MARK, '1');
    if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') el.style.setProperty('display', 'none', 'important');
  }
  function restore(el) {
    const old = hidden.get(el);
    if (!old) return;
    if (old.marker === null) el.removeAttribute(MARK); else el.setAttribute(MARK, old.marker);
    if (old.display) el.style.setProperty('display', old.display, old.priority); else el.style.removeProperty('display');
    hidden.delete(el);
  }
  function putAttribute(el, name, value) {
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
  }
  function syncFrames() {
    // 已确认广告中的 iframe 改为空白沙箱，尽力停止后续活动。
    // 这不能撤销已经发出的请求，也不能关闭已经弹出的窗口。
    for (const el of hidden.keys()) {
      const frames = el.localName === 'iframe' ? [el] : el.querySelectorAll('iframe');
      for (const f of frames) {
        if (!frameStates.has(f)) frameStates.set(f, { src: f.getAttribute('src'), srcdoc: f.getAttribute('srcdoc'), sandbox: f.getAttribute('sandbox') });
        if (f.getAttribute('sandbox') !== '') f.setAttribute('sandbox', '');
        if (f.hasAttribute('srcdoc')) f.removeAttribute('srcdoc');
        if (f.getAttribute('src') !== 'about:blank') f.setAttribute('src', 'about:blank');
      }
    }
    for (const [f, old] of frameStates) {
      if (config.enabled && f.isConnected && f.closest(`[${MARK}="1"]`)) continue;
      frameStates.delete(f);
      putAttribute(f, 'sandbox', old.sandbox);
      putAttribute(f, 'srcdoc', old.srcdoc);
      putAttribute(f, 'src', old.src);
    }
  }
  function visit(root, selector, fn) {
    if (root.nodeType === 1 && root.matches(selector)) fn(root);
    root.querySelectorAll?.(selector).forEach(fn);
  }
  function scan(root = document) {
    if (!config.enabled || own(root)) return;
    const inspect = el => {
      const why = reasonFor(el);
      if (why) hide(el, why);
      else if (hidden.has(el)) restore(el);
    };
    visit(root, CANDIDATES, inspect);
    for (const rule of config.rules.filter(activeRule)) {
      if (rule.kind === 'selector') visit(root, rule.value, inspect);
    }
    for (const el of temporary) {
      if (el.isConnected) inspect(el); else temporary.delete(el);
    }
    // 重新评估已隐藏元素，允许广告位被站点改成普通内容后恢复。
    for (const el of [...hidden.keys()]) {
      if (!el.isConnected) restore(el);
      else if (root === document || root === el || root.contains?.(el)) inspect(el);
    }
    syncFrames(); updateUI();
  }
  function queue(root = document) {
    if (!config.enabled || own(root)) return;
    pending.add(root);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const roots = [...pending]; pending.clear();
      if (roots.length > 40 || roots.includes(document)) scan();
      else for (const r of roots) if (r.isConnected) scan(r);
    }, 100);
  }
  function ensureStyle() {
    if (!document.documentElement || hiddenStyle?.isConnected) return;
    hiddenStyle = document.createElement('style');
    hiddenStyle.textContent = `[${MARK}="1"] { display: none !important; }`;
    (document.head || document.documentElement).append(hiddenStyle);
  }
  const observer = new MutationObserver(records => {
    ensureStyle();
    for (const r of records) {
      if (own(r.target)) continue;
      if (r.type === 'attributes') {
        const old = frameStates.get(r.target);
        if (old && r.attributeName === 'src' && r.target.getAttribute('src') !== 'about:blank') old.src = r.target.getAttribute('src');
        if (old && r.attributeName === 'srcdoc' && r.target.hasAttribute('srcdoc')) old.srcdoc = r.target.getAttribute('srcdoc');
        queue(r.target);
      }
      else {
        r.addedNodes.forEach(n => { if (n.nodeType === 1) queue(n); });
        if (r.removedNodes.length) queue(r.target);
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'id', 'src', 'srcdoc', 'href', 'style', 'data-src', 'data-ad-slot', 'data-shb', MARK] });
  ensureStyle();

  // 必须写入页面的 window，才能拦截页面脚本的 window.open。
  // 不替换 fetch/XHR，不破坏章节图片、评论请求或同站链接。
  function installPopupGuard() {
    const original = page.open;
    if (typeof original !== 'function') return;
    const wrapped = function (...args) {
      const raw = args[0] == null ? '' : String(args[0]);
      const u = urlOf(raw);
      const sameSite = u && /^https?:$/.test(u.protocol) && (u.hostname === 'rawinu.com' || u.hostname.endsWith('.rawinu.com'));
      const direct = lastDirectLink && Date.now() - lastDirectLink.time < 1200 && u?.href === lastDirectLink.href;
      const blocked = config.enabled && (isAdURL(raw) || (config.strictPopups && (!raw || !sameSite) && !direct));
      if (blocked) {
        popupCount++;
        log('弹窗', u?.hostname || '空白窗口'); updateUI();
        return null;
      }
      return Reflect.apply(original, page, args);
    };
    try { page.open = wrapped; popupHookOK = page.open === wrapped; }
    catch { popupHookOK = false; }
  }
  installPopupGuard();
  function onActivation(e) {
    if (!config.enabled || e.composedPath().includes(host)) return;
    if (pick) {
      if (e.type === 'click') clickPick(e);
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    const el = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!el) return;
    if (isAdURL(el.href)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'click' || e.type === 'auxclick') { rejectedLinks++; updateUI(); }
      return;
    }
    if (e.isTrusted && (e.type === 'click' || e.type === 'auxclick')) lastDirectLink = { href: el.href, time: Date.now() };
  }
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'auxclick']) {
    window.addEventListener(type, onActivation, { capture: true, passive: false });
  }

  function tell(text) { if (hint) hint.textContent = text; }
  function button(text, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.addEventListener('click', e => { e.preventDefault(); fn(); }); return b;
  }
  function updateUI() {
    if (!statusNode) return;
    statusNode.textContent = `${config.enabled ? '清理中' : '已暂停'} · 隐藏 ${[...hidden.keys()].filter(e => e.isConnected).length} · 弹窗 ${popupCount}`;
    shadow.getElementById('toggle').textContent = config.enabled ? '暂停并恢复页面' : '恢复清理';
    shadow.getElementById('strict').textContent = `限制站外脚本弹窗：${config.strictPopups ? '开' : '关'}`;
    shadow.getElementById('rules').textContent = `已记住 ${config.rules.length} 条规则 · 阻止广告链接 ${rejectedLinks} 次`;
  }
  function setEnabled() {
    config.enabled = !config.enabled;
    stopPick();
    if (!config.enabled) { [...hidden.keys()].forEach(restore); syncFrames(); } else queue();
    persist(); tell(config.enabled ? '已恢复清理。' : '已恢复被隐藏的元素，弹窗限制也已暂停。');
  }
  function undo() {
    const rule = config.rules.pop();
    if (!rule) return tell('没有可撤销的点选规则。');
    [...hidden.keys()].forEach(restore); persist(); queue(); tell('已撤销最后一条规则。');
  }
  function report() {
    // 不含页面正文、图片、cookie、查询参数、表单值或完整浏览地址。
    const frames = [...document.querySelectorAll('iframe')].filter(e => !hidden.has(e)).slice(0, 30).map(e => ({
      host: e.src ? urlOf(e.src)?.hostname : '', inline: e.hasAttribute('srcdoc'),
      width: Math.round(e.getBoundingClientRect().width), height: Math.round(e.getBoundingClientRect().height),
    }));
    const data = { version: VERSION, host: location.hostname, pageType: /chapter/i.test(location.pathname) ? 'chapter' : 'other',
      enabled: config.enabled, popupHookOK, strictPopups: config.strictPopups,
      savedRules: config.rules.length, hidden: hidden.size, popupCount, frames, events };
    const text = JSON.stringify(data, null, 2);
    try { GM_setClipboard(text, 'text'); tell('诊断信息已复制。可粘贴给我继续改进；不含网页正文。'); }
    catch { window.prompt('复制诊断信息', text); }
  }
  function createUI() {
    if (host || !document.body) return;
    host = document.createElement('div'); host.id = UI;
    host.style.cssText = 'all:initial!important;position:fixed!important;right:14px!important;bottom:14px!important;z-index:2147483647!important;display:block!important;';
    shadow = host.attachShadow({ mode: 'closed' });
    const css = document.createElement('style');
    css.textContent = `:host{color-scheme:light}*{box-sizing:border-box}button{font:13px/1.5 system-ui,sans-serif;cursor:pointer;border:1px solid #cbd5e1;border-radius:7px;padding:7px 10px;background:#fff;color:#172033;text-align:left}button:hover{background:#eef4ff}#badge{position:relative;z-index:3;background:#172033;color:white;border:0;box-shadow:0 2px 14px #0003}#panel{position:relative;z-index:3;width:295px;max-width:90vw;max-height:72vh;overflow:auto;background:#fff;color:#172033;border:1px solid #cbd5e1;border-radius:12px;padding:12px;margin-bottom:8px;font:13px/1.6 system-ui,sans-serif;box-shadow:0 5px 22px #0003}#panel[hidden]{display:none}h3{font-size:15px;margin:0 0 7px}.buttons{display:grid;gap:6px}p{margin:8px 0 0;overflow-wrap:anywhere}#hint{color:#475569}#frame{display:none;pointer-events:none;position:fixed;border:3px solid #f43f5e;background:#f43f5e18;z-index:2}#shield{display:none;position:fixed;inset:0;z-index:1;cursor:crosshair;background:transparent}`;
    shadow.append(css);
    details = document.createElement('section'); details.id = 'panel'; details.hidden = true;
    const title = document.createElement('h3'); title.textContent = 'RawINU 广告清理'; details.append(title);
    statusNode = document.createElement('p'); details.append(statusNode);
    const group = document.createElement('div'); group.className = 'buttons'; details.append(group);
    const add = (text, fn, id) => { const b = button(text, fn); if (id) b.id = id; group.append(b); };
    add('标记漏网广告', startPick);
    add('扩大选区 ↑', () => changeSelection('parent'));
    add('缩小选区 ↓', () => changeSelection('child'));
    add('隐藏并记住选区', saveSelection);
    add('取消选择（Esc）', stopPick);
    add('撤销最后一条规则', undo);
    add('暂停并恢复页面', setEnabled, 'toggle');
    add('限制站外脚本弹窗：开', () => { config.strictPopups = !config.strictPopups; persist(); }, 'strict');
    add('重新扫描', () => { queue(); tell('已安排重新扫描。'); });
    add('复制诊断信息', report);
    const ruleInfo = document.createElement('p'); ruleInfo.id = 'rules'; details.append(ruleInfo);
    hint = document.createElement('p'); hint.id = 'hint'; hint.textContent = popupHookOK ? '动态广告会自动重扫；点选规则仅保存在本机。' : '弹窗保护未能挂接；页面隐藏仍可用。'; details.append(hint);
    const badge = button('广告清理', () => { expanded = !expanded; details.hidden = !expanded; }); badge.id = 'badge';
    frame = document.createElement('div'); frame.id = 'frame';
    shield = document.createElement('div'); shield.id = 'shield';
    const underneath = e => document.elementsFromPoint(e.clientX, e.clientY).find(el => !own(el));
    shield.addEventListener('mousemove', e => { if (pick && !pick.locked) preview(underneath(e)); });
    shield.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (pick && !pick.locked) preview(underneath(e));
      lockPick();
    });
    shadow.append(shield, details, badge, frame);
    for (const type of ['click', 'auxclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) host.addEventListener(type, e => e.stopPropagation());
    document.body.append(host); updateUI();
  }
  function showUI() { createUI(); expanded = true; if (details) details.hidden = false; }
  function startPick() {
    if (!config.enabled) return tell('请先恢复清理，再标记广告。');
    stopPick(); pick = { element: null, locked: false, children: [] }; showUI();
    shield.style.display = 'block';
    tell('移动鼠标预览红框，点击锁定，再点“隐藏并记住选区”。Esc 取消。');
    window.addEventListener('mousemove', hoverPick, true);
    window.addEventListener('click', clickPick, true);
    window.addEventListener('keydown', keyPick, true);
  }
  function stopPick() {
    pick = null;
    if (frame) frame.style.display = 'none';
    if (shield) shield.style.display = 'none';
    window.removeEventListener('mousemove', hoverPick, true);
    window.removeEventListener('click', clickPick, true);
    window.removeEventListener('keydown', keyPick, true);
  }
  function selectElement(el) {
    if (!pick || !(el instanceof Element) || protectedElement(el)) return;
    pick.element = el;
    const rect = el.getBoundingClientRect();
    Object.assign(frame.style, { display: 'block', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function hoverPick(e) {
    if (!pick || pick.locked || e.composedPath().includes(host)) return;
    preview(e.target);
  }
  function preview(el) {
    if (!pick) return;
    if (!(el instanceof Element) || protectedElement(el)) { pick.element = null; frame.style.display = 'none'; return; }
    selectElement(el);
  }
  function clickPick(e) {
    if (!pick || e.composedPath().includes(host)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!pick.locked) selectElement(e.target);
    lockPick();
  }
  function lockPick() { if (pick?.element) { pick.locked = true; tell(`已选 ${pick.element.localName}。可扩大/缩小选区，然后隐藏并记住。`); } }
  function keyPick(e) { if (e.key === 'Escape') { e.preventDefault(); stopPick(); tell('已取消选择。'); } }
  function changeSelection(direction) {
    if (!pick?.element) return tell('先移动鼠标并点击锁定一个广告。');
    if (direction === 'parent') {
      const parent = pick.element.parentElement;
      if (!parent || protectedElement(parent)) return tell('该范围包含阅读内容或页面主要结构，请选择更小的广告区域。');
      pick.children.push(pick.element); selectElement(parent);
    } else if (pick.children.length) selectElement(pick.children.pop());
    pick.locked = true;
  }
  function cssEscape(s) {
    return CSS.escape(s);
  }
  function makeRule(el) {
    const scope = location.pathname;
    const unique = selector => document.querySelectorAll(selector).length === 1;
    if (el.id && !/\d{6}|[a-f0-9]{16}/i.test(el.id)) {
      const value = `#${cssEscape(el.id)}`;
      if (unique(value)) return { kind: 'selector', value, path: /(^|[-_])ads?([-_]|$)|advert/i.test(el.id) ? null : scope };
    }
    const classes = [...el.classList].filter(c => /(^|[-_])ads?([-_]|$)|advert/i.test(c));
    for (const c of classes) {
      const value = `${el.localName}.${cssEscape(c)}`;
      if (unique(value)) return { kind: 'selector', value, path: null };
    }
    if (['img', 'iframe', 'a'].includes(el.localName)) {
      const value = resourceOf(el) && resourceKey(resourceOf(el));
      if (value) return { kind: 'resource', value, tag: el.localName, path: scope };
    }
    // 没有稳定特征时，不把易漂移的 nth-child 位置当成永久规则。
    return null;
  }
  function saveSelection() {
    const el = pick?.element;
    if (!el || !el.isConnected || protectedElement(el)) return tell('请先选中一个独立广告。');
    const rule = makeRule(el);
    if (!rule) {
      temporary.add(el); stopPick(); hide(el, '本页临时选择'); syncFrames();
      tell('已临时隐藏。这个元素没有稳定标记，刷新后需重新选择，避免误伤其它位置。'); updateUI(); return;
    }
    const count = [...document.querySelectorAll(rule.kind === 'selector' ? rule.value : rule.tag)].filter(n => ruleMatches(n, rule)).length;
    if (count > 1 && !window.confirm(`这条规则会匹配 ${count} 个元素。确认都属于广告并记住？`)) return;
    if (!config.rules.some(r => JSON.stringify(r) === JSON.stringify(rule))) config.rules.push(rule);
    config.rules = config.rules.slice(-100);
    stopPick(); persist(); queue(); tell('已记住，下次打开适用页面会自动隐藏。误拦可撤销。');
  }

  GM_registerMenuCommand('打开广告清理面板', showUI);
  GM_registerMenuCommand('标记漏网广告', startPick);
  GM_registerMenuCommand('暂停 / 恢复清理', setEnabled);
  GM_registerMenuCommand('撤销最后一条规则', undo);
  GM_registerMenuCommand('复制诊断信息', report);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { createUI(); queue(); }, { once: true });
  else { createUI(); queue(); }
  window.addEventListener('pageshow', () => queue());
  window.addEventListener('popstate', () => { [...hidden.keys()].forEach(restore); queue(); });
  window.addEventListener('hashchange', () => queue());
  // 可见页面低频兜底，处理无 DOM 变更的路由变化；主要工作由 MutationObserver 驱动。
  setInterval(() => { if (!document.hidden && config.enabled) queue(); }, 8000);
})();
