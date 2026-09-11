'use strict';
/**
 * lib/smtp.js — 零依赖 SMTP 客户端（465 implicit TLS）
 *
 * 支持场景：163/126/QQ/企业邮等标准 SMTP（授权码作密码）。
 * 协议流：TLS 连接 ← 220 → EHLO → 250 → AUTH LOGIN → 334×2 → 235 →
 *         MAIL FROM → RCPT TO → DATA → 354 → 正文 → 250 → QUIT。
 * 多行应答（250-xxx）按「第 4 字符为空格」判终。
 */
const tls = require('tls');

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

/** 主题按 RFC2047 B 编码（中文安全） */
function encSubject(subject) {
  return '=?UTF-8?B?' + b64(String(subject || '')).replace(/(.{76})/g, '$1\r\n ') + '?=';
}

/** 纯文本正文 base64 分行（76 字符/行，RFC 限制） */
function b64Wrap(s) { return b64(s).replace(/(.{76})/g, '$1\r\n'); }

function buildMime({ from, senderName, to, subject, text, html }) {
  const headers = [
    'From: ' + (senderName ? senderName + ' ' : '') + '<' + from + '>',
    'To: <' + to + '>',
    'Subject: ' + encSubject(subject),
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
  ];
  if (html) {
    const boundary = 'cb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    const textPart = [
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Wrap(String(text || '')),
    ].join('\r\n');
    const htmlPart = [
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Wrap(String(html)),
    ].join('\r\n');
    return headers.join('\r\n') + '\r\n\r\n' + [textPart, htmlPart, '--' + boundary + '--', ''].join('\r\n');
  }
  headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  return headers.join('\r\n') + '\r\n\r\n' + b64Wrap(String(text || ''));
}

/**
 * 发一封 SMTP 邮件（TLS 直连，465 implicit TLS；25/587 明文+STARTTLS 不支持——163/QQ 均走 465）
 * @returns Promise<{ messageId: string }>
 */
function sendSmtp({ host, port, user, pass, from, senderName, to, subject, text, html }, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!host || !user || !pass || !from || !to) return reject(Object.assign(new Error('SMTP 配置不完整'), { code: 'SMTP_CONFIG' }));
    const sock = tls.connect({ host, port: Number(port) || 465, servername: host });
    let buf = '';
    let step = 0;               // 0=等220 1=EHLO后 2=AUTH用户名 3=AUTH密码 4=MAIL 5=RCPT 6=DATA头 7=发完等250
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { sock.destroy(); reject(Object.assign(new Error('SMTP 超时(' + timeoutMs + 'ms)'), { code: 'SMTP_TIMEOUT' })); }
    }, timeoutMs);

    const fail = (e) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); reject(Object.assign(new Error(e), { code: 'SMTP_FAIL' })); } };

    const sendLine = (line) => sock.write(line + '\r\n');

    const onData = () => {
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line || line.length < 3) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const cont = line[3] === '-';                 // 多行应答继续读
        if (cont) continue;
        const body = line.slice(4);
        if (code >= 500) return fail('SMTP ' + code + ': ' + body + ' (step ' + step + ')');
        switch (step) {
          case 0:                                     // 220 greet
            if (code !== 220) return fail('SMTP 握手异常: ' + line);
            step = 1; sendLine('EHLO cartback.local'); break;
          case 1:                                     // 250 EHLO 应答（可能多行，已由 cont 处理）
            if (code !== 250) return fail('EHLO 失败: ' + line);
            step = 2; sendLine('AUTH LOGIN'); break;
          case 2:                                     // 334 Username:
            if (code !== 334) return fail('AUTH 用户名阶段异常: ' + line);
            step = 3; sendLine(b64(user)); break;
          case 3:                                     // 334 Password:
            if (code !== 334) return fail('AUTH 认证失败（检查授权码）: ' + line);
            step = 4; sendLine(b64(pass)); break;
          case 4:                                     // 235 认证成功
            if (code !== 235) return fail('AUTH 被拒: ' + line);
            step = 5; sendLine('MAIL FROM:<' + from + '>'); break;
          case 5:                                     // 250
            if (code !== 250) return fail('MAIL FROM 被拒: ' + line);
            step = 6; sendLine('RCPT TO:<' + to + '>'); break;
          case 6:                                     // 250
            if (code !== 250) return fail('RCPT TO 被拒: ' + line);
            step = 7; sendLine('DATA'); break;
          case 7:                                     // 354
            if (code !== 354) return fail('DATA 未就绪: ' + line);
            step = 8;
            sendLine(buildMime({ from, senderName, to, subject, text, html }).replace(/\r\n\./g, '\r\n..'));  // 点填充
            sendLine('.');
            break;
          case 8:                                     // 250 已入队
            if (code !== 250) return fail('投递被拒: ' + line);
            done = true; clearTimeout(timer);
            sendLine('QUIT');
            sock.end(() => resolve({ messageId: '<' + Date.now().toString(36) + '@cartback>' }));
            setTimeout(() => resolve({ messageId: '<' + Date.now().toString(36) + '@cartback>' }), 1500);  // QUIT 应答兜底
            break;
          default: break;
        }
      }
    };

    sock.on('data', (d) => { buf += d.toString('utf8'); onData(); });
    sock.on('error', (e) => fail('SMTP 连接错误: ' + (e && e.message || e)));
    sock.on('close', () => { if (!done) fail('SMTP 连接提前关闭'); });
  });
}

module.exports = { sendSmtp, buildMime, encSubject };
