// Melden, Namensänderung nach einer Sperre und Betreiber-Ansicht (Phase 8f). Wird im Konto-Fenster der Startseite und im Spiel verwendet.
const LMMod = (function () {
  const L = LMO;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, cls, fn) => { const b = mk('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; if (fn) b.onclick = fn; return b; };
  function msgBox() { const m = mk('p', 'accmsg'); m.setAttribute('role', 'status'); m.setAttribute('aria-live', 'polite'); return { m, set(t, kind) { m.textContent = t || ''; m.className = 'accmsg' + (kind ? ' ' + kind : ''); } }; }
  const KNOWN = ['BAD_NAME', 'NAME_TAKEN', 'RULES_MOD', 'REPORT_DUP', 'REPORT_LIMIT', 'REPORT_SELF', 'NOT_ADMIN', 'RENAME_NOT_ALLOWED', 'NETWORK', 'NOT_SIGNED_IN', 'NO_PROFILE'];
  const errText = e => { const m = (e && e.message) || String(e); return e && e.code && !KNOWN.includes(e.code) ? m + ' [Technisch: ' + e.code + (e.detail ? ', ' + String(e.detail).slice(0, 120) : '') + ']' : m; };
  function confirmBtn(b, ask, fn) {
    let armed = false, t = null; const orig = b.textContent;
    b.onclick = () => {
      if (!armed) { armed = true; b.textContent = ask; t = setTimeout(() => { armed = false; b.textContent = orig; }, 5000); return; }
      clearTimeout(t); armed = false; b.textContent = orig; fn(b);
    };
  }
  const ago = ms => { const m = Math.round((L.serverNow() - ms) / 60000); return m < 2 ? 'gerade eben' : m < 90 ? 'vor ' + m + ' Min.' : m < 2880 ? 'vor ' + Math.round(m / 60) + ' Std.' : 'vor ' + Math.round(m / 1440) + ' Tagen'; };

  // Kleine Fahne als Knopf für „Melden“ (Name des Ziels nur für Vorlesehilfen)
  function flagBtn(name, fn) {
    const b = mk('button', 'flag'); b.type = 'button'; b.title = 'Melden'; b.setAttribute('aria-label', 'Melden: ' + name);
    const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '14'); s.setAttribute('height', '14'); s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', 'M3 1.5v13M3 2.5h8.5l-2 3 2 3H3'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p); b.appendChild(s); b.onclick = fn; return b;
  }

  // Meldeformular: target = { k: 'p' | 'c', id, name }; opts.back() führt zurück
  function reportForm(host, target, opts) {
    opts = opts || {}; host.textContent = '';
    const root = mk('div', 'accform'), mb = msgBox();
    root.appendChild(mk('h4', '', (target.k === 'c' ? 'Clan melden: ' : 'Spieler melden: ') + target.name));
    root.appendChild(mk('p', 'note', 'Wähle den Grund. Die Meldung sieht nur der Betreiber, sie ist nicht öffentlich. Der Betreiber prüft jede Meldung selbst; es wird nichts automatisch gesperrt.'));
    const fs = mk('fieldset', 'rep'); fs.appendChild(mk('legend', '', 'Grund'));
    let chosen = '';
    const go = btn('Melden', 'primary'), cancel = btn('Abbrechen', '', () => { if (opts.back) opts.back(); });
    go.disabled = true;
    for (const [k, label] of L.mod.reasons) {
      const l = mk('label', 'chk'), r = document.createElement('input'); r.type = 'radio'; r.name = 'reason'; r.value = k;
      r.onchange = () => { chosen = k; go.disabled = false; mb.set(''); };
      l.append(r, mk('span', '', label)); fs.appendChild(l);
    }
    go.onclick = async () => {
      go.disabled = true; cancel.disabled = true; mb.set('');
      try {
        await L.mod.report(target, chosen);
        host.textContent = ''; const done = mk('div', 'accform');
        done.appendChild(mk('p', 'accmsg ok', 'Danke, die Meldung ist angekommen.'));
        if (opts.back) done.appendChild(btn('Zurück', '', opts.back));
        host.appendChild(done);
      } catch (e) { mb.set(errText(e), 'err'); console.warn('Melden:', e && e.code, e && e.detail); go.disabled = false; cancel.disabled = false; }
    };
    const row = mk('div', 'accrow'); row.append(go, cancel);
    root.append(fs, mb.m, row); host.appendChild(root);
    const f = fs.querySelector('input'); if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }

  // Neuer Name nach einer Sperre. opts.onDone(neuerName) wird nach dem Speichern aufgerufen.
  function renameForm(host, opts) {
    opts = opts || {}; host.textContent = '';
    const root = mk('div', 'accform'), mb = msgBox(), s = L.state();
    root.appendChild(mk('p', 'accmsg err', 'Dein Name „' + s.name + '“ wurde vom Betreiber gesperrt. Bitte wähle einen neuen Namen.'));
    root.appendChild(mk('p', 'note', 'Dein Unternehmen, deine Spielstände und dein Konto bleiben erhalten. Der neue Name erscheint in den Ranglisten und ist für alle angemeldeten Spieler sichtbar. Wähle am besten keinen echten Namen.'));
    const w = mk('label', 'fld'); w.appendChild(mk('span', 'fl', 'Neuer Spielername (3 bis 16 Zeichen)'));
    const i = document.createElement('input'); i.type = 'text'; i.name = 'newname'; i.maxLength = 16; i.autocomplete = 'off'; i.setAttribute('autocapitalize', 'off'); i.spellcheck = false;
    const sug = btn('Vorschlag', '', () => { i.value = L.suggestName(); i.dispatchEvent(new Event('input')); }), row = mk('div', 'nrow'); row.append(i, sug); w.appendChild(row);
    const go = btn('Neuen Namen speichern', 'primary');
    i.addEventListener('input', () => { const e = L.tidyName(i.value).length >= 3 ? L.checkName(i.value) : ''; if (e) mb.set(e, 'err'); else if (mb.m.className.includes('err')) mb.set(''); });
    const submit = async () => {
      go.disabled = true; mb.set(''); const old = go.textContent; go.textContent = 'Bitte warten …';
      try { const st = await L.rename(i.value); if (opts.onDone) opts.onDone(st.name); }
      catch (e) { mb.set(errText(e), 'err'); console.warn('Umbenennen:', e && e.code, e && e.detail); go.disabled = false; go.textContent = old; }
    };
    go.onclick = submit; i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    root.append(w, mb.m, go); host.appendChild(root);
    try { i.focus({ preventScroll: true }); } catch (e) {}
  }

  // Betreiber-Ansicht: Meldungen prüfen, Namen sperren oder freigeben
  const STATUS = { current: 'Name noch aktuell', changed: 'inzwischen geändert', gone: 'Clan nicht mehr vorhanden', unknown: 'Status unbekannt' };
  async function adminPanel(host, flash) {
    const seq = host._modSeq = (host._modSeq || 0) + 1;
    host.textContent = ''; host.appendChild(mk('p', 'note', 'Meldungen werden geladen …'));
    let groups, blocked;
    try { [groups, blocked] = await Promise.all([L.mod.reports(), L.mod.blockedList()]); }
    catch (e) { if (seq !== host._modSeq || !host.isConnected) return; host.textContent = ''; const mb = msgBox(); mb.set(errText(e), 'err'); host.append(mb.m, btn('Erneut versuchen', '', () => adminPanel(host))); return; }
    if (seq !== host._modSeq || !host.isConnected) return;
    host.textContent = '';
    const root = mk('div', 'accform'), mb = msgBox(), again = f => adminPanel(host, f);
    if (flash) root.appendChild(mk('p', 'accmsg ok', flash));
    root.appendChild(mk('p', 'note', 'Nur du siehst diesen Bereich. Gemeldet wird nichts automatisch gesperrt. „Sperren“ setzt den Namen auf die Sperrliste: er kann nie wieder gewählt werden, Ranglisten verbergen ihn sofort, und der Spieler muss sich einen neuen wählen. Ein gesperrter Clan wird aufgelöst.'));
    const reasonLabel = Object.fromEntries(L.mod.reasons);
    root.appendChild(mk('h4', '', 'Offene Meldungen (' + groups.length + ')'));
    const ul = mk('ul', 'cl'); root.appendChild(ul); if (!groups.length) ul.replaceWith(mk('p', 'note', 'Keine offenen Meldungen.'));
    for (const g of groups) {
      const li = mk('li', ''), tx = mk('div', '');
      tx.appendChild(mk('span', 'tt', g.name + ' · ' + (g.k === 'c' ? 'Clan' : 'Spieler') + ' · ' + g.count + (g.count === 1 ? ' Meldung' : ' Meldungen')));
      const why = Object.keys(g.reasons).map(r => (reasonLabel[r] || r) + (g.reasons[r] > 1 ? ' ×' + g.reasons[r] : '')).join(', ');
      tx.appendChild(mk('span', 'ss', why + ' · zuletzt ' + ago(g.last) + ' · ' + (g.blocked ? 'Name bereits gesperrt' : STATUS[g.status] || STATUS.unknown)));
      const acts = mk('div', 'acts'), blk = btn('Sperren', 'danger'), dis = btn('Verwerfen', '');
      if (g.blocked) blk.disabled = true;
      confirmBtn(blk, g.k === 'c' ? 'Name sperren und Clan auflösen?' : 'Name sperren?', async b => {
        b.disabled = true; mb.set('');
        try { await L.mod.block(g); await again('„' + g.name + '“ ist gesperrt.'); } catch (e) { mb.set(errText(e), 'err'); b.disabled = false; }
      });
      dis.onclick = async () => { dis.disabled = true; mb.set(''); try { await L.mod.dismiss(g); await again('Die Meldungen zu „' + g.name + '“ wurden verworfen.'); } catch (e) { mb.set(errText(e), 'err'); dis.disabled = false; } };
      acts.append(blk, dis); li.append(tx, acts); ul.appendChild(li);
    }
    root.appendChild(mk('h4', '', 'Gesperrte Namen (' + blocked.length + ')'));
    const ul2 = mk('ul', 'cl'); root.appendChild(ul2); if (!blocked.length) ul2.replaceWith(mk('p', 'note', 'Noch keine gesperrten Namen.'));
    for (const x of blocked) {
      const li = mk('li', ''), tx = mk('div', ''), un = btn('Freigeben', '');
      tx.appendChild(mk('span', 'tt', x.key.replace(/_/g, ' '))); tx.appendChild(mk('span', 'ss', 'gesperrt ' + ago(x.t)));
      confirmBtn(un, 'Wirklich freigeben?', async b => { b.disabled = true; mb.set(''); try { await L.mod.unblock(x.key); await again('„' + x.key.replace(/_/g, ' ') + '“ ist wieder frei.'); } catch (e) { mb.set(errText(e), 'err'); b.disabled = false; } });
      const acts = mk('div', 'acts'); acts.appendChild(un); li.append(tx, acts); ul2.appendChild(li);
    }
    const ref = btn('Aktualisieren', '', () => again());
    const row = mk('div', 'accrow'); row.appendChild(ref);
    root.append(mb.m, row); host.appendChild(root);
  }

  return { flagBtn, reportForm, renameForm, adminPanel, errText };
})();
