// ==UserScript==
// @name         RawINU 广告清理与规则记忆
// @namespace    local.rawinu.ad-cleaner
// @version      1.2.7
// @homepageURL  https://github.com/garyseesee/userscripts
// @supportURL   https://github.com/garyseesee/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/garyseesee/userscripts/main/rawinu-ad-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/garyseesee/userscripts/main/rawinu-ad-cleaner.user.js
// @description  支持 RawINU 与 NihonKuni：清理广告框、限制弹窗和当前页自动外跳，点选记忆、撤销和暂停。
// @match        *://rawinu.com/*
// @match        *://*.rawinu.com/*
// @match        *://nihonkuni.com/*
// @match        *://*.nihonkuni.com/*
// @run-at       document-start
// @sandbox      JavaScript
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  // 这是页面清理脚本，不是浏览器网络过滤器。删除 script 不能撤销已经执行的代码。
  // 不在运行时加载远程代码或上传浏览记录；新版由 Tampermonkey 按更新设置下载。
  // 只保存当前主机的用户设置和点选规则。
  const VERSION = '1.2.7';
  const UPDATE_URL = 'https://raw.githubusercontent.com/garyseesee/userscripts/main/rawinu-ad-cleaner.user.js';
  const SITE_DOMAIN = ['rawinu.com', 'nihonkuni.com'].find(h => location.hostname === h || location.hostname.endsWith(`.${h}`));
  if (!SITE_DOMAIN) return;
  const SITE_NAME = SITE_DOMAIN === 'nihonkuni.com' ? 'NihonKuni' : 'RawINU';
  const KEY = `rawinu-cleaner:v1:${location.hostname}`;
  const MARK = 'data-rawinu-cleaner-hidden';
  const UI = 'rawinu-ad-cleaner-ui';
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const defaults = { enabled: true, strictPopups: true, blockRedirects: true, rules: [] };
  let saved;
  try { saved = GM_getValue(KEY, defaults); } catch { saved = defaults; }
  const config = {
    enabled: saved?.enabled !== false,
    strictPopups: saved?.strictPopups !== false,
    blockRedirects: saved?.blockRedirects !== false,
    rules: Array.isArray(saved?.rules) ? saved.rules.filter(validRule).slice(-100) : [],
  };

  // 前五项来自 2026-09-26 检查的 RawINU 章节页；完整主机边界匹配。
  const AD_HOSTS = [
    'arsonojuncoes.com', 'nuancedmorosis.com', 'olivedrawer.com',
    'cabretpardao.com', 'zipcrypticbroadsheet.com',
    'cuculireactor.qpon',
    // 2026-10-01 NihonKuni 源码与实际广告框中确认的来源。
    'cryoselarolla.com', 'hameltnoummos.com', 'broadlyjukeboxunrevised.com',
    'jads.co', 'criteo.com', 'adeqmedia.com',
    // 2026-10-04 章节引用的广告脚本包含 mouseout 后直接修改 location 的逻辑。
    'wienerschumar.com',
    // 2026-10-05 用户反馈：点下一章后新开此广告落地页。
    'valuemedia-ltd.com',
    // 2026-10-08 RawINU 首页 1XBET：广告 iframe 与透明点击层共用的来源。
    'traffmovie.com',
    'doubleclick.net', 'googlesyndication.com', 'adsterra.com',
    'popads.net', 'popcash.net', 'exoclick.com',
  ];
  const BUILTIN = [
    // 当前三路广告脚本共用的悬浮层根节点；包含通知、宝箱、礼物及插屏。
    '[data-shb="1"]',
    '.ad-sandbox-container', 'ins.adsbygoogle', '[data-ad-slot]',
    '[id^="google_ads_iframe"]', '[id^="div-gpt-ad"]',
    '.ad-container', '.ad-slot', '.advertisement',
    // 2026-10-04 RawINU 实际章节：第 2、3 张图片之间的横幅，30 秒后重建内容。
    ...(SITE_DOMAIN === 'rawinu.com' ? ['#ad-slik'] : []),
    // 首页实测的整块广告位；不依赖创意图片、随机 class 或点击层的资源规则。
    ...(SITE_DOMAIN === 'rawinu.com' ? ['#zone_1772741137'] : []),
    ...(SITE_DOMAIN === 'nihonkuni.com' ? [
      '.ad-placeholder', 'ins[id="1127812"]',
      // 实际元素检查确认的嵌套 Criteo 横幅外层；内层框没有顶层可见 src。
      '.st-intop-slot', '.st-placement', '.st-adunit', 'iframe.st-standard-ads-sandbox',
    ] : []),
  ];
  const PROTECTED = 'html,body,head,main,nav,header,footer,form,#chapter-images,.chapter-content,.chapter-img,.img-wrapper,.chapter-images,.chapter-image-wrapper,.reading-content,.reading-controls-wrapper,.reading-header';
  const CANDIDATES = [...BUILTIN, 'iframe', 'img[src]', 'img[data-src]', 'a[href]'].join(',');
  const hidden = new Map();
  const frameStates = new Map();
  const temporary = new Set();
  const events = [];
  const pending = new Set();
  let timer = null, host, shadow, statusNode, details, hint, frame, shield;
  let hiddenStyle, stylePath, styleText, pick = null, popupCount = 0, rejectedLinks = 0, popupHookOK = false;
  let expanded = false, lastDirectLink = null, navigationIntent = null;
  let redirectCount = 0, navigationHookOK = false;

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
    ensureStyle(true);
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
  function knownReasonFor(el) {
    if (el.matches(BUILTIN.join(','))) return '广告容器';
    if (['iframe', 'img', 'a'].includes(el.localName) && resourceOf(el) && isAdURL(resourceOf(el))) return '已知广告来源';
    return null;
  }
  function reasonFor(el) {
    if (protectedElement(el)) return null;
    if (temporary.has(el)) return '本页临时选择';
    const known = knownReasonFor(el);
    if (known) return known;
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
  function hideKnown(root, subtree = true) {
    if (!config.enabled || own(root)) return;
    const inspect = el => {
      if (protectedElement(el)) return;
      const why = knownReasonFor(el);
      // 已隐藏元素的样式修复留给批处理，避免与站点的样式观察器反复互相触发。
      if (why && !hidden.has(el)) hide(el, why);
    };
    // 只做轻量识别和隐藏，不解析 srcdoc、不遍历自定义规则、不停用框架。
    // MutationObserver 回调内完成，避免已知广告再等待 100ms 批处理后才消失。
    if (subtree) visit(root, CANDIDATES, inspect);
    else if (root.nodeType === 1) inspect(root);
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
    ensureStyle();
    pending.add(root);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const roots = [...pending]; pending.clear();
      if (roots.length > 40 || roots.includes(document)) scan();
      else for (const r of roots) if (r.isConnected) scan(r);
    }, 100);
  }
  function ensureStyle(refresh = false) {
    if (!document.documentElement) return;
    if (refresh || stylePath !== location.pathname) {
      stylePath = location.pathname;
      styleText = `[${MARK}="1"] { display: none !important; }`;
      if (config.enabled) {
        // 先放入已知广告及当前路径的记忆规则，元素出现时由 CSS 直接隐藏。
        // 同样排除阅读区、表单、面板及包含这些内容的祖先；不隐藏整页等待扫描。
        const selectors = [...BUILTIN, ...config.rules.filter(r => r.kind === 'selector' && activeRule(r)).map(r => r.value)];
        const protectedSelectors = `${PROTECTED},#${UI}`;
        styleText += `\n:is(${selectors.join(',')}):not(${protectedSelectors}):not(:has(${protectedSelectors})) { display: none !important; }`;
      }
    }
    if (!hiddenStyle?.isConnected) {
      hiddenStyle = document.createElement('style');
      hiddenStyle.textContent = styleText;
      (document.head || document.documentElement).append(hiddenStyle);
    } else if (hiddenStyle.textContent !== styleText) hiddenStyle.textContent = styleText;
  }
  const observer = new MutationObserver(records => {
    ensureStyle();
    for (const r of records) {
      if (own(r.target)) continue;
      if (r.type === 'attributes') {
        const old = frameStates.get(r.target);
        if (old && r.attributeName === 'src' && r.target.getAttribute('src') !== 'about:blank') old.src = r.target.getAttribute('src');
        if (old && r.attributeName === 'srcdoc' && r.target.hasAttribute('srcdoc')) old.srcdoc = r.target.getAttribute('srcdoc');
        hideKnown(r.target, false);
        queue(r.target);
      }
      else {
        r.addedNodes.forEach(n => { if (n.nodeType === 1) { hideKnown(n); queue(n); } });
        if (r.removedNodes.length) queue(r.target);
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'id', 'src', 'srcdoc', 'href', 'style', 'data-src', 'data-ad-slot', 'data-shb', MARK] });
  ensureStyle();
  // 兼容脚本启动时页面已存在内容的情况；详细扫描仍保留批处理。
  hideKnown(document);

  // 当前广告借用空白 iframe 的 open，或提交隐藏表单，绕过顶层 open。
  // 同源 iframe 在交给调用者前装好保护；不读取跨域框、不替换网络请求。
  const guardedRealms = new WeakSet();
  function sameSiteURL(u) {
    return u && /^https?:$/.test(u.protocol) && (u.hostname === SITE_DOMAIN || u.hostname.endsWith(`.${SITE_DOMAIN}`));
  }
  function rememberNavigationIntent(e) {
    // 只有真实的链接点击或表单操作能放行对应地址；鼠标移出和模拟 click 不算。
    if (!e.isTrusted || (e.type === 'keydown' && e.key !== 'Enter')) return;
    navigationIntent = null;
    if (!config.enabled || pick) return;
    const target = e.composedPath().find(n => n?.nodeType === 1);
    if (!target) return;
    const link = e.type === 'click' && target.closest('a[href],area[href]');
    let raw = link?.href;
    let sourceForm = null;
    if (!raw) {
      const control = target.closest('button,input,select');
      const submitter = control && ((control.localName === 'button' && control.type === 'submit') ||
        (control.localName === 'input' && ['submit', 'image'].includes(control.type)));
      if (control?.form && (submitter || (e.type === 'keydown' && control.localName === 'input'))) {
        raw = submitter && control.hasAttribute('formaction') ? control.formAction : control.form.action;
        sourceForm = control.form;
      }
    }
    const u = raw && urlOf(raw);
    if (u && !isAdURL(u.href)) navigationIntent = { href: u.href, form: sourceForm, action: u.origin + u.pathname, time: Date.now() };
  }
  function installNavigationGuard() {
    // Location 的属性不能可靠重写。使用 Chrome 的导航事件，在离开当前页前取消。
    // 跨域导航不能 intercept()，但 cancelable 为 true 时可以 preventDefault()。
    try {
      if (typeof page.navigation?.addEventListener !== 'function') return;
      page.navigation.addEventListener('navigate', e => {
        if (!config.enabled || !config.blockRedirects || !e.cancelable || e.defaultPrevented ||
            ['reload', 'traverse'].includes(e.navigationType)) return;
        const u = e.destination?.url && urlOf(e.destination.url);
        if (!u || sameSiteURL(u)) return;
        const intent = navigationIntent;
        const submittedForm = intent?.form && (e.sourceElement === intent.form || e.sourceElement?.form === intent.form);
        const direct = intent && Date.now() - intent.time < 1200 &&
          (submittedForm ? intent.action === u.origin + u.pathname : !intent.form && intent.href === u.href);
        if (direct && !isAdURL(u.href)) { navigationIntent = null; return; }
        e.preventDefault();
        if (e.defaultPrevented) {
          redirectCount++; log('阻止自动外跳', u.hostname || u.protocol); updateUI();
          tell('已阻止网页自动跳到站外，继续保留当前阅读位置。');
        }
      }, { capture: true });
      navigationHookOK = true;
    } catch { /* 无此能力时明确显示，不以弹窗提示或循环后退困住用户。 */ }
  }
  installNavigationGuard();
  function blockPopup(raw, kind = '弹窗') {
    const u = urlOf(raw);
    const direct = lastDirectLink && Date.now() - lastDirectLink.time < 1200 && u?.href === lastDirectLink.href;
    if (!config.enabled || !(isAdURL(raw) || (config.strictPopups && (!raw || !sameSiteURL(u)) && !direct))) return false;
    popupCount++; log(kind, u?.hostname || '空白窗口'); updateUI(); return true;
  }
  function blockForm(form) {
    if (!config.enabled) return false;
    let concealed = false;
    for (let el = form; el; el = el.parentElement) {
      const css = el.ownerDocument.defaultView.getComputedStyle(el);
      if (el.hidden || css.display === 'none' || css.visibility === 'hidden') { concealed = true; break; }
    }
    // 保留正常可见表单和同站评论；隐藏站外表单是已确认的广告弹窗后备通道。
    return (isAdURL(form.action) || concealed) && blockPopup(form.action, '广告表单');
  }
  function installRealmGuards(win) {
    try {
      // 以 Document 标识：iframe 导航后的 WindowProxy 相同，但 Document 会改变。
      const doc = win.document;
      if (!doc || guardedRealms.has(doc)) return;
      guardedRealms.add(doc);
      win.addEventListener('click', rememberNavigationIntent, true);
      win.addEventListener('keydown', rememberNavigationIntent, true);
      const original = win.open;
      const wrapped = function (...args) {
        const raw = args[0] == null ? '' : String(args[0]);
        if (blockPopup(raw)) return null;
        return Reflect.apply(original, this == null ? win : this, args);
      };
      win.open = wrapped;
      if (win === page) popupHookOK = win.open === wrapped;
      const fp = win.HTMLFormElement.prototype;
      for (const method of ['submit', 'requestSubmit']) {
        const native = fp[method];
        if (typeof native !== 'function') continue;
        fp[method] = function (...args) {
          if (blockForm(this)) return;
          return Reflect.apply(native, this, args);
        };
      }
      doc.addEventListener('submit', e => {
        if (e.target instanceof win.HTMLFormElement && blockForm(e.target)) {
          e.preventDefault(); e.stopImmediatePropagation();
        }
      }, true);
      const ip = win.HTMLIFrameElement.prototype;
      for (const property of ['contentWindow', 'contentDocument']) {
        const descriptor = Object.getOwnPropertyDescriptor(ip, property);
        if (!descriptor?.get || !descriptor.configurable) continue;
        Object.defineProperty(ip, property, { ...descriptor, get() {
          const value = Reflect.apply(descriptor.get, this, []);
          if (value) installRealmGuards(property === 'contentWindow' ? value : value.defaultView);
          return value;
        } });
      }
    } catch { /* 浏览器拒绝访问的跨域或沙箱框保持原样。 */ }
  }
  installRealmGuards(page);
  function isChapterLink(el) {
    // 只保护已确认的翻页控件及同一作品的直达章节链接。
    // 不拦评论、章节选择框等依赖站点 JavaScript 的操作。
    if (SITE_DOMAIN !== 'rawinu.com') return false;
    const selector = '#rd-side_icon a.rd_top-left, #rd-side_icon a.rd_top-right, .input-group > .prev > a, .input-group > .next > a';
    if (!el.matches(selector) || el.hasAttribute('download')) return false;
    const u = urlOf(el.href);
    if (!u || u.origin !== location.origin || u.search || u.hash) return false;
    const pattern = /^\/(?:unir|read)-(.+)-chapter-\d+(?:\.\d+)*\.html$/;
    const current = location.pathname.match(pattern);
    const next = u.pathname.match(pattern);
    return !!current && !!next && current[1] === next[1];
  }
  function isListPageLink(el) {
    // 2026-10-10 实际列表页：页码与 «/» 均为原生链接，筛选条件保存在 query 中。
    // 仅隔离已确认的分页区；不影响搜索表单、排序按钮或依赖 JS 的其它控件。
    if (SITE_DOMAIN !== 'rawinu.com' || location.pathname !== '/manga-list.html' ||
        !el.matches('ul.pagination.pagination-v4 > li > a[href]') || el.hasAttribute('download')) return false;
    const u = urlOf(el.href);
    if (!u || u.origin !== location.origin || u.pathname !== '/manga-list.html' || u.hash) return false;
    return u.searchParams.getAll('listType').length === 1 && u.searchParams.get('listType') === 'pagination' &&
      u.searchParams.getAll('page').length === 1 && /^[1-9]\d*$/.test(u.searchParams.get('page') || '');
  }
  function isDirectoryChapterLink(el) {
    // 2026-10-10 实际作品页：目录通过 XHR 插入，a 包住 li/章节名称；另有阅读按钮。
    // 每次事件现场判断，覆盖新插入、排序、替换后的链接，不依赖初次扫描。
    if (SITE_DOMAIN !== 'rawinu.com' || el.hasAttribute('download') ||
        !el.matches('#list-chapter ul.list-chapters > a[href], #bt-reading.read-action > a[href]')) return false;
    const current = location.pathname.match(/^\/manga-(.+)\.html$/);
    const u = urlOf(el.href);
    if (!current || !u || u.origin !== location.origin || u.search || u.hash) return false;
    const next = u.pathname.match(/^\/(?:unir|read)-(.+)-chapter-\d+(?:\.\d+)*\.html$/);
    return !!next && current[1] === next[1];
  }
  function isProtectedNavigationLink(el) { return isChapterLink(el) || isListPageLink(el) || isDirectoryChapterLink(el); }
  function protectNavigationKey(e) {
    if (!config.enabled || !config.strictPopups || pick || e.key !== 'Enter') return;
    const el = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (el && isProtectedNavigationLink(el)) e.stopImmediatePropagation();
  }
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, protectNavigationKey, true);
  function onActivation(e) {
    if (e.composedPath().includes(host)) {
      // 网页的全局捕获监听器会吞掉点击。只转发本脚本封闭面板内的点击，
      // 让按钮和选取层正常响应，同时不把这些事件交给网页广告监听器。
      const target = (e.detail === 0 ? shadow?.activeElement : null) || shadow?.elementFromPoint?.(e.clientX, e.clientY);
      if (target && target.getRootNode() === shadow) {
        e.stopImmediatePropagation();
        if (e.type === 'click') {
          e.preventDefault();
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: false,
            clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons, detail: e.detail,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }));
        }
      }
      return;
    }
    if (!config.enabled) return;
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
    if (config.strictPopups && isProtectedNavigationLink(el)) {
      // 在 window 捕获阶段隔离按下、松开和点击，广告不能借此次手势另开标签。
      // 不 preventDefault、不改写 href/target，也不模拟点击；由浏览器完成原生翻页，
      // 保留 Cmd/Ctrl 点击、中键与键盘 Enter 的默认行为。
      e.stopImmediatePropagation();
    }
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick']) {
    window.addEventListener(type, onActivation, { capture: true, passive: false });
  }

  function tell(text) { if (hint) hint.textContent = text; }
  function openUpdatePage() {
    showUI(); stopPick();
    try {
      const url = new URL(UPDATE_URL);
      // 仅在主动点击时打开固定仓库地址；时间参数减少旧源码缓存，不包含当前网页信息。
      url.searchParams.set('_update', String(Date.now()));
      GM_openInTab(url.href, { active: true, setParent: true });
      tell(`已打开更新入口。在油猴页面确认更新后，返回漫画页刷新；本页仍运行 v${VERSION}。`);
    } catch {
      tell('无法打开更新入口。请在 Chrome 的油猴菜单中检查用户脚本更新。');
    }
  }
  function button(text, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.addEventListener('click', e => { e.preventDefault(); fn(); }); return b;
  }
  function updateUI() {
    if (!statusNode) return;
    statusNode.textContent = `${config.enabled ? '清理中' : '已暂停'} · 隐藏 ${[...hidden.keys()].filter(e => e.isConnected).length} · 弹窗 ${popupCount} · 外跳 ${redirectCount}`;
    shadow.getElementById('toggle').textContent = config.enabled ? '暂停并恢复页面' : '恢复清理';
    shadow.getElementById('strict').textContent = `限制站外脚本弹窗：${config.strictPopups ? '开' : '关'}`;
    shadow.getElementById('redirects').textContent = `阻止自动外跳：${navigationHookOK ? (config.blockRedirects ? '开' : '关') : '浏览器不支持'}`;
    shadow.getElementById('rules').textContent = `已记住 ${config.rules.length} 条规则 · 阻止广告链接 ${rejectedLinks} 次`;
  }
  function setEnabled() {
    config.enabled = !config.enabled;
    stopPick();
    if (!config.enabled) { [...hidden.keys()].forEach(restore); syncFrames(); } else queue();
    persist(); tell(config.enabled ? '已恢复清理。' : '已恢复被隐藏的元素，弹窗和外跳限制也已暂停。');
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
      navigationHookOK, blockRedirects: config.blockRedirects, redirectCount,
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
    css.textContent += '#update{background:#2563eb;color:#fff;border-color:#2563eb}#update:hover{background:#1d4ed8}';
    shadow.append(css);
    details = document.createElement('section'); details.id = 'panel'; details.hidden = true;
    const title = document.createElement('h3'); title.textContent = `${SITE_NAME} 广告清理 v${VERSION}`; details.append(title);
    statusNode = document.createElement('p'); details.append(statusNode);
    const group = document.createElement('div'); group.className = 'buttons'; details.append(group);
    const add = (text, fn, id) => { const b = button(text, fn); if (id) b.id = id; group.append(b); };
    add('更新脚本', openUpdatePage, 'update');
    add('标记漏网广告', startPick);
    add('扩大选区 ↑', () => changeSelection('parent'));
    add('缩小选区 ↓', () => changeSelection('child'));
    add('隐藏并记住选区', saveSelection);
    add('取消选择（Esc）', stopPick);
    add('撤销最后一条规则', undo);
    add('暂停并恢复页面', setEnabled, 'toggle');
    add('限制站外脚本弹窗：开', () => { config.strictPopups = !config.strictPopups; persist(); }, 'strict');
    add('阻止自动外跳：开', () => { config.blockRedirects = !config.blockRedirects; navigationIntent = null; persist(); }, 'redirects');
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
  GM_registerMenuCommand('更新脚本', openUpdatePage);
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
