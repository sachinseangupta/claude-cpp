(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), compileMsg: $('compile-msg'), preview: $('preview'),
    compilerOutput: $('compiler-output'), runOutput: $('run-output'),
    send: $('btn-send'), stop: $('btn-stop'), session: $('session'),
    chat: $('chat'), empty: $('empty'),
  };
  let busy = false;
  let language = 'cpp';

  const post = (type, extra) => vscode.postMessage({ type, ...extra });
  $('btn-compile').addEventListener('click', () => post('compile'));
  $('btn-new').addEventListener('click', () => post('new-session'));
  $('btn-source').addEventListener('click', () => post('open-source'));
  $('btn-vocabulary').addEventListener('click', () => post('open-vocabulary'));
  el.send.addEventListener('click', () => post('send'));
  el.stop.addEventListener('click', () => post('stop'));
  const langButtons = document.querySelectorAll('.seg button');
  langButtons.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.language !== language) post('set-language', { language: b.dataset.language });
  }));

  // ---- small, safe markdown renderer (input is escaped before any tags are added) ----
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }
  function markdown(src) {
    const parts = src.split('```');
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[^\n]*\n/, ''); // drop the language tag line
        html += '<pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>';
        return;
      }
      let list = null; // 'ul' | 'ol'
      let para = [];
      const flushPara = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } };
      const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
      for (const line of part.split('\n')) {
        let m;
        if ((m = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line))) {
          flushPara(); closeList();
          html += '<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>';
        } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
          flushPara();
          if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
          html += '<li>' + inline(m[1]) + '</li>';
        } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
          flushPara();
          if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
          html += '<li>' + inline(m[1]) + '</li>';
        } else if (line.trim() === '') {
          flushPara(); closeList();
        } else {
          closeList();
          para.push(inline(line));
        }
      }
      flushPara(); closeList();
    });
    return html;
  }

  // ---- state ----
  // C++ is compiled and then run; Python is just run.
  const LANGS = {
    cpp: { name: 'C++', run: 'Compile', runTitle: 'Compile and run', ok: 'compiled', busy: 'compiling' },
    python: { name: 'Python', run: 'Run', runTitle: 'Run', ok: 'ready', busy: 'running' },
  };
  const langInfo = () => LANGS[language] || LANGS.cpp;
  const emptyText = () => 'Write your instructions in ' + langInfo().name + ", save, then send. Claude's replies appear here.";

  function setBlock(node, text) {
    node.hidden = !text;
    node.textContent = text || '';
  }

  function applyLanguage(s) {
    language = LANGS[s.language] ? s.language : 'cpp';
    const info = langInfo();
    langButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.language === language)));
    $('btn-source').textContent = s.sourceName;
    $('btn-source').title = 'Open ' + s.sourceName;
    $('btn-vocabulary').textContent = s.vocabularyName;
    $('btn-vocabulary').title = 'Open ' + s.vocabularyName;
    $('btn-compile').textContent = info.run;
    $('btn-compile').title = info.runTitle + ' ' + s.sourceName;
    if (el.empty) el.empty.textContent = emptyText();
  }

  function applyState(s) {
    busy = s.busy;
    applyLanguage(s);
    const info = langInfo();
    const labels = { idle: 'idle', compiling: info.busy, ok: info.ok, error: 'error', untrusted: 'untrusted' };
    el.status.textContent = labels[s.status] || s.status;
    el.status.dataset.status = s.status;
    el.compileMsg.textContent = s.message || '';
    // On failure the compiler output is what matters; otherwise show the prompt.
    setBlock(el.compilerOutput, s.status === 'error' ? s.compilerOutput || s.message : '');
    setBlock(el.runOutput, s.runOutput ? s.runOutput.trim() : '');
    el.preview.textContent = s.prompt || (s.status === 'ok' ? '' : 'Nothing to send yet.');
    el.send.disabled = !(s.status === 'ok') || s.busy;
    el.stop.hidden = !s.busy;
    el.session.textContent = s.hasSession ? 'Follow-ups continue the same conversation.' : '';
    document.getElementById('working')?.remove();
    if (s.busy) appendNode(node('div', 'msg', 'Claude is working', 'working'));
  }

  // ---- chat ----
  function node(tag, cls, text, id) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (id) n.id = id;
    if (text != null) n.textContent = text;
    return n;
  }
  function appendNode(n) {
    const stick = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 60;
    if (el.empty) { el.empty.remove(); el.empty = null; }
    const working = document.getElementById('working');
    if (working && n.id !== 'working') el.chat.insertBefore(n, working); else el.chat.appendChild(n);
    if (stick) el.chat.scrollTop = el.chat.scrollHeight;
  }

  function addChat(entry) {
    if (entry.role === 'you') {
      const wrap = node('div', 'msg you');
      const from = LANGS[entry.language] || LANGS.cpp;
      wrap.appendChild(node('div', 'who', 'You · ' + (entry.language === 'python' ? 'run from ' : 'compiled from ') + from.name));
      const d = document.createElement('details');
      const first = (entry.text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || 'prompt').trim();
      d.appendChild(node('summary', '', first.length > 90 ? first.slice(0, 87) + '…' : first));
      d.appendChild(node('pre', '', entry.text));
      wrap.appendChild(d);
      return appendNode(wrap);
    }
    const e = entry.event;
    switch (e.kind) {
      case 'text': {
        const wrap = node('div', 'msg claude');
        wrap.appendChild(node('div', 'who', 'Claude'));
        const body = document.createElement('div');
        body.innerHTML = markdown(e.text);
        wrap.appendChild(body);
        return appendNode(wrap);
      }
      case 'tool': {
        const t = node('div', 'tool');
        t.appendChild(node('b', '', e.name));
        t.appendChild(document.createTextNode(e.summary ? '  ' + e.summary : ''));
        return appendNode(t);
      }
      case 'tool-error':
        return appendNode(node('div', 'tool err', 'Tool error: ' + e.text));
      case 'error':
        return appendNode(node('div', 'notice err', e.message));
      case 'result': {
        if (!e.ok && e.text) appendNode(node('div', 'notice err', e.text));
        if (e.denied && e.denied.length) {
          const list = e.denied.map((d) => d.tool + (d.summary ? ' (' + d.summary + ')' : '')).join(', ');
          appendNode(node('div', 'notice',
            'Claude asked to use tools that are not permitted in this panel: ' + list +
            '. Add them to claudeCpp.allowedTools or change claudeCpp.permissionMode in Settings, then send again.'));
        }
        const bits = [e.ok ? 'Done' : 'Failed'];
        if (e.durationMs != null) bits.push((e.durationMs / 1000).toFixed(1) + 's');
        if (e.costUsd != null) bits.push('$' + e.costUsd.toFixed(3));
        return appendNode(node('div', 'footer', bits.join(' · ')));
      }
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'state') applyState(m.state);
    else if (m.type === 'chat') addChat(m.entry);
    else if (m.type === 'chat-reset') {
      el.chat.textContent = '';
      el.empty = node('div', 'dim', emptyText(), 'empty');
      el.chat.appendChild(el.empty);
    }
  });

  post('ready');
})();
