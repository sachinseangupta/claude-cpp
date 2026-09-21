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

  const post = (type) => vscode.postMessage({ type });
  $('btn-compile').addEventListener('click', () => post('compile'));
  $('btn-new').addEventListener('click', () => post('new-session'));
  $('btn-source').addEventListener('click', () => post('open-source'));
  $('btn-header').addEventListener('click', () => post('open-header'));
  el.send.addEventListener('click', () => post('send'));
  el.stop.addEventListener('click', () => post('stop'));

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
  const LABELS = { idle: 'idle', compiling: 'compiling', ok: 'compiled', error: 'error', untrusted: 'untrusted' };

  function setBlock(node, text) {
    node.hidden = !text;
    node.textContent = text || '';
  }

  function applyState(s) {
    busy = s.busy;
    el.status.textContent = LABELS[s.status] || s.status;
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
      wrap.appendChild(node('div', 'who', 'You · compiled from C++'));
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
      el.empty = node('div', 'dim', "Write your instructions in C++, save, then send. Claude's replies appear here.", 'empty');
      el.chat.appendChild(el.empty);
    }
  });

  post('ready');
})();
