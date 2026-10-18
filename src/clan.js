// Clan-Ansicht: gründen, beitreten, Mitglieder, Leitung. Wird im Konto-Fenster der Startseite und in der Rangliste im Spiel verwendet.
const LMClan = (function () {
  const L = LMO;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn) => { const b = mk('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; if (fn) b.onclick = fn; return b; };
  const eur = v => Math.round(v).toLocaleString('de-DE') + ' €';
  function field(label, o) {
    const w = mk('label', 'fld'); w.appendChild(mk('span', 'fl', label));
    const i = document.createElement('input'); i.type = 'text'; i.name = o.name; i.autocomplete = 'off'; i.maxLength = o.max || 40; if (o.ph) i.placeholder = o.ph;
    i.setAttribute('autocapitalize', 'off'); i.spellcheck = false;
    if (o.extra) { const row = mk('div', 'nrow'); row.appendChild(i); row.appendChild(o.extra); w.appendChild(row); } else w.appendChild(i);
    if (o.hint) w.appendChild(mk('small', 'fh', o.hint));
    return { w, i };
  }
  function msgBox() { const m = mk('p', 'accmsg'); m.setAttribute('role', 'status'); m.setAttribute('aria-live', 'polite'); return { m, set(t, kind) { m.textContent = t || ''; m.className = 'accmsg' + (kind ? ' ' + kind : ''); } }; }
  const KNOWN = ['BAD_NAME', 'CLAN_HAVE', 'CLAN_BAD_CODE', 'CLAN_NAME_TAKEN', 'CLAN_FULL', 'CLAN_OWNER_LEAVE', 'CLAN_NOT_OWNER', 'CLAN_GONE', 'RULES_CLAN', 'NETWORK', 'NOT_SIGNED_IN', 'NO_PROFILE'];
  const errText = e => { const m = (e && e.message) || String(e); return e && e.code && !KNOWN.includes(e.code) ? m + ' [Technisch: ' + e.code + (e.detail ? ', ' + String(e.detail).slice(0, 120) : '') + ']' : m; };
  // Zweistufige Bestätigung: erster Klick fragt nach, zweiter führt aus
  function confirmBtn(b, ask, fn) {
    let armed = false, t = null; const orig = b.textContent;
    b.onclick = () => {
      if (!armed) { armed = true; b.textContent = ask; t = setTimeout(() => { armed = false; b.textContent = orig; }, 5000); return; }
      clearTimeout(t); armed = false; b.textContent = orig; fn(b);
    };
  }
  // Führt eine Aktion aus, sperrt den Knopf währenddessen und zeigt Fehler an
  async function act(b, mb, work) {
    const old = b.textContent; b.disabled = true; mb.set('');
    try { await work(); return true; } catch (e) { mb.set(errText(e), 'err'); console.warn('Clan:', e && e.code, e && e.detail); b.disabled = false; b.textContent = old; return false; }
  }

  // Zeichnet die Clan-Ansicht in host. flash: Hinweis, der nach dem Neuzeichnen oben steht. hooks.report(ziel) öffnet das Meldeformular (ohne hooks gibt es keine Melden-Knöpfe).
  async function render(host, flash, hooks) {
    const seq = host._clanSeq = (host._clanSeq || 0) + 1;
    host.textContent = ''; host.appendChild(mk('p', 'note', 'Clan wird geladen …'));
    let res;
    try { res = await L.clan.refresh(); }
    catch (e) {
      if (seq !== host._clanSeq || !host.isConnected) return;
      host.textContent = ''; const mb = msgBox(); mb.set(errText(e), 'err'); host.appendChild(mb.m); host.appendChild(btn('Erneut versuchen', '', () => render(host))); return;
    }
    if (seq !== host._clanSeq || !host.isConnected) return;
    host.textContent = '';
    const again = f => render(host, f, hooks);
    host.appendChild(res ? memberView(res, again, flash, hooks || {}) : noClanView(again, flash));
    if (res && res.err && res.err.code !== 'NETWORK') console.warn('Clan-Wertung:', res.err.code, res.err.detail);
  }

  function noClanView(again, flash) {
    const root = mk('div', 'accform');
    if (flash) root.appendChild(mk('p', 'accmsg ok', flash));
    root.appendChild(mk('p', 'note', 'Ein Clan ist eine kleine Gruppe von bis zu ' + L.clan.cap + ' Spielern. In der Clan-Rangliste zählt das Wachstum aller Mitglieder zusammen. Beitreten kann man nur mit dem geheimen Code des Clans.'));
    const mb = msgBox();
    const fn = field('Name des neuen Clans (3 bis 16 Zeichen)', { name: 'clanname', max: 16, ph: 'z. B. Die Boten' }), go = btn('Clan gründen', 'primary');
    go.onclick = () => act(go, mb, async () => { await L.clan.create(fn.i.value); await again('Der Clan ist gegründet. Gib den Code an Freunde weiter, damit sie beitreten können.'); });
    const fc = field('Code eines Clans', { name: 'clancode', max: 16, ph: 'CL-XXXX-XXXX' }), jo = btn('Beitreten', 'primary');
    jo.onclick = () => act(jo, mb, async () => { const m = await L.clan.join(fc.i.value); await again('Du bist jetzt im Clan „' + m.name + '“.'); });
    for (const [i, b] of [[fn.i, go], [fc.i, jo]]) i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); b.click(); } });
    const a = mk('div', 'accform'), b2 = mk('div', 'accform');
    a.append(mk('h4', '', 'Clan gründen'), fn.w, go); b2.append(mk('h4', '', 'Clan beitreten'), fc.w, jo);
    root.append(a, b2, mb.m);
    return root;
  }

  function memberView(res, again, flash, hooks) {
    const m = res.m, root = mk('div', 'accform'), mb = msgBox();
    if (flash) root.appendChild(mk('p', 'accmsg ok', flash));
    const head = mk('div', ''), nm = mk('p', '', m.name); nm.style.cssText = 'margin:0 0 2px;font:600 17px var(--font-ui);color:var(--ink)'; head.appendChild(nm);
    head.appendChild(mk('p', 'note', (m.isOwner ? 'Du bist der Leiter. ' : 'Du bist Mitglied. ') + m.members.length + ' von ' + m.cap + ' Plätzen belegt.'));
    root.appendChild(head);
    if (m.code) {
      const cin = document.createElement('input'); cin.type = 'text'; cin.readOnly = true; cin.value = L.clan.fmtCode(m.code); cin.setAttribute('aria-label', 'Beitrittscode'); cin.onfocus = () => cin.select();
      const cp = btn('Kopieren', '', async () => { try { await navigator.clipboard.writeText(cin.value); cp.textContent = 'Kopiert'; setTimeout(() => { cp.textContent = 'Kopieren'; }, 1500); } catch (e) { cin.focus(); cin.select(); } });
      const f = mk('label', 'fld'); f.appendChild(mk('span', 'fl', 'Beitrittscode (nur an Menschen weitergeben, die mitspielen sollen)'));
      const row = mk('div', 'nrow'); row.append(cin, cp); f.appendChild(row); root.appendChild(f);
    }
    const t = res.total, sum = mk('p', '', ''); sum.style.cssText = 'margin:0;font-variant-numeric:tabular-nums';
    sum.appendChild(mk('b', '', 'Wachstum des Clans: ')); sum.appendChild(document.createTextNode('heute ' + eur(t.day) + ' · Woche ' + eur(t.week) + ' · gesamt ' + eur(t.all)));
    root.appendChild(sum);
    const ul = mk('ul', 'cl');
    for (const r of res.rows) {
      const li = mk('li', ''), tx = mk('div', ''), mine = r.uid === L.state().uid;
      tx.appendChild(mk('span', 'tt', r.name + (r.owner ? ' · Leiter' : '') + (mine ? ' (du)' : '') + (r.counts ? '' : ' · zählt nicht (Clan voll)')));
      tx.appendChild(mk('span', 'ss', 'heute ' + eur(r.day) + ' · Woche ' + eur(r.week) + ' · gesamt ' + eur(r.all)));
      li.appendChild(tx);
      const acts = mk('div', 'acts');
      if (m.isOwner && !mine) {
        const lead = btn('Leitung', ''), kick = btn('Entfernen', 'danger');
        confirmBtn(lead, 'Leitung übergeben?', b => act(b, mb, async () => { await L.clan.transfer(r.uid); await again('Die Leitung liegt jetzt bei ' + r.name + '.'); }));
        confirmBtn(kick, 'Wirklich entfernen?', b => act(b, mb, async () => { await L.clan.kick(r.uid); await again(r.name + ' wurde aus dem Clan entfernt.'); }));
        acts.append(lead, kick);
      }
      if (hooks.report && !mine && !r.hidden) acts.appendChild(btn('Melden', '', () => hooks.report({ k: 'p', id: r.uid, name: r.name })));
      if (acts.children.length) li.appendChild(acts);
      ul.appendChild(li);
    }
    root.appendChild(ul);
    root.appendChild(mk('p', 'note', 'Gezählt wird bei jedem Mitglied das Wachstum des besten Unternehmens (Geld plus Wert von Fahrzeugen und Ausbauten). Der Beitrag wird beim Spielen etwa alle 5 Minuten aktualisiert.'));
    const row = mk('div', 'accrow');
    if (m.isOwner) {
      const rn = btn('Neuen Code erzeugen', ''), ds = btn('Clan auflösen', 'danger');
      confirmBtn(rn, 'Alten Code ungültig machen?', b => act(b, mb, async () => { await L.clan.renew(); await again('Der neue Code gilt. Bisherige Mitglieder bleiben im Clan.'); }));
      confirmBtn(ds, 'Alle Mitglieder entfernen und auflösen?', b => act(b, mb, async () => { await L.clan.disband(); await again('Der Clan wurde aufgelöst.'); }));
      row.append(rn, ds);
      if (m.members.length > 1) root.appendChild(mk('p', 'note', 'Als Leiter kannst du den Clan erst verlassen, wenn du die Leitung übergeben hast (Knopf „Leitung“ bei einem Mitglied).'));
    } else {
      const lv = btn('Clan verlassen', 'danger');
      confirmBtn(lv, 'Wirklich verlassen?', b => act(b, mb, async () => { const n = m.name; await L.clan.leave(); await again('Du hast den Clan „' + n + '“ verlassen.'); }));
      row.appendChild(lv);
      if (hooks.report) row.appendChild(btn('Clan-Namen melden', '', () => hooks.report({ k: 'c', id: m.cid, name: m.name })));
    }
    root.append(mb.m, row);
    return root;
  }

  // Tabelle der Clan-Rangliste für den Zeitraum scope; myId hebt den eigenen Clan hervor
  async function table(scope, myId, onReport) {
    const rows = await L.clan.top(scope, 25), tb = mk('table', 'rk'), hd = mk('tr');
    hd.append(mk('th', 'n', '#'), mk('th', null, 'Clan'), mk('th', 'n', 'Mitglieder'), mk('th', 'n', 'Wachstum')); if (onReport) hd.appendChild(mk('th', 'f', '')); tb.appendChild(hd);
    rows.forEach((r, i) => {
      const tr = mk('tr', r.cid === myId ? 'me' : ''); tr.append(mk('td', 'n', String(i + 1)), mk('td', null, r.name), mk('td', 'n', String(r.m)), mk('td', 'n', eur(r.g)));
      if (onReport) { const td = mk('td', 'f'); if (r.cid !== myId) td.appendChild(LMMod.flagBtn(r.name, () => onReport({ k: 'c', id: r.cid, name: r.name }))); tr.appendChild(td); }
      tb.appendChild(tr);
    });
    return { rows, node: tb };
  }

  return { render, table, errText };
})();
