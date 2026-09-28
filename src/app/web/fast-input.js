/* Input presentation only. Legal actions and boundaries always come from the server. */
(function (root) {
  'use strict';
  function parseAmount(text, unit, bigBlind) {
    var raw = String(text).trim();
    if (!raw) return { error: '请输入金额' };
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return { error: '请输入正数，不能包含负号、指数或无效字符' };
    raw = raw.replace(/,/g, '');
    if (raw.length > 32) return { error: '金额超出可处理范围' };
    var parts = raw.split('.');
    var digits = parts[1] || '';
    var scale = 10n ** BigInt(digits.length);
    var numerator = BigInt(parts[0] + digits) * BigInt(unit === 'BB' ? bigBlind : 1);
    if (numerator % scale !== 0n) return { error: '金额必须精确到 1 个筹码，不能含零碎筹码' };
    var chips = numerator / scale;
    if (chips <= 0n) return { error: '金额必须大于 0' };
    if (chips > BigInt(Number.MAX_SAFE_INTEGER)) return { error: '金额超出可处理范围' };
    return { chips: Number(chips) };
  }
  function formatBB(chips, bigBlind) {
    var whole = Math.floor(chips / bigBlind), remainder = chips % bigBlind, fraction = '';
    for (var i = 0; remainder && i < 12; i++) {
      remainder *= 10; fraction += Math.floor(remainder / bigBlind); remainder %= bigBlind;
    }
    return String(whole) + (fraction ? '.' + fraction : '');
  }
  function create(ctx) {
    var app = ctx.app, $ = ctx.$, el = ctx.el, clear = ctx.clear;
    if (!$('amountInput')) return null;
    var unit = 'CHIPS';
    try { unit = root.localStorage.getItem('dsh.amountUnit') === 'BB' ? 'BB' : 'CHIPS'; } catch (_) {}
    var draftKey = '', canonical = null, canonicalText = null, composing = false, lastActionAt = -Infinity;
    var amount = $('amountInput');
    function facts() { return app.preview && app.preview.amountInput; }
    function value() {
      if (canonical !== null && amount.value === canonicalText) return { chips: canonical };
      return parseAmount(amount.value, unit, facts() ? facts().bigBlindChips : app.state ? app.state.bigBlindBB : 100);
    }
    function fmt(chips) { return unit === 'BB' ? formatBB(chips, facts().bigBlindChips) + ' BB' : Number(chips).toLocaleString('en-US'); }
    function fill(chips) {
      canonical = chips;
      canonicalText = unit === 'BB' ? formatBB(chips, facts().bigBlindChips) : String(chips);
      amount.value = canonicalText;
      updateAmount(false);
    }
    function fail(message) { $('amountError').textContent = message; amount.setAttribute('aria-invalid', message ? 'true' : 'false'); }
    function updateAmount(showError) {
      var f = facts(), v = value();
      if (!f) { $('amountHelp').textContent = '先加入玩家、选择手牌并录入前位行动'; return; }
      var text = v.chips !== undefined ? (unit === 'BB' ? v.chips.toLocaleString('en-US') + ' 筹码' : formatBB(v.chips, f.bigBlindChips) + ' BB') + ' · 本街总投入' : '金额表示本街累计投入目标';
      text += '　|　本街已投入 ' + fmt(f.committedChips);
      if (v.chips !== undefined) text += ' · 本次需补 ' + fmt(Math.max(0, v.chips - f.committedChips));
      $('amountHelp').textContent = text;
      if (showError) fail(v.error || ''); else fail('');
    }
    function actorText() {
      var p=app.preview, s=p.seats.find(function(s){return s.seatId===p.currentActorSeatId;});
      return s ? (s.isHero ? '我（Hero）' : s.displayName) + ' · ' + (s.handRole || s.logicalPosition) : '';
    }
    function canAct() { return !ctx.busy() && !app.pendingMutation && !app.cardEditing && !composing && performance.now()-lastActionAt > 350; }
    function act(type, chips) {
      if (!canAct() || app.preview.legalActionTypes.indexOf(type) < 0) return Promise.resolve(false);
      lastActionAt = performance.now();
      return ctx.sendOp({ kind:'ACT', action: Object.assign({type:type}, chips === undefined ? {} : {amountChips:chips}) });
    }
    function allin() {
      if (!canAct() || app.preview.legalActionTypes.indexOf('ALL_IN') < 0) return;
      var f=facts(), key=app.state.tableId + ':' + app.revision;
      var m=$('modal'); clear(m); m.appendChild(el('h3',null,'确认全下'));
      m.appendChild(el('div','confirm-allin',actorText() + ' · 本次投入 ' + fmt(f.remainingChips)));
      m.appendChild(el('p','hint','本街累计投入到 ' + fmt(f.allInToChips) + '。此操作会记录真实行动。'));
      var yes=el('button','danger','确认全下'); yes.id='confirmAllin';
      yes.onclick=function(){if(key!==app.state.tableId+':'+app.revision){ctx.closeModal();return;}ctx.closeModal();act('ALL_IN');};
      m.appendChild(yes); var no=el('button',null,'取消'); no.onclick=ctx.closeModal; m.appendChild(no); $('overlay').className='show';
    }
    function submit() {
      if (!canAct()) return;
      var f=facts(); if(!f || (!f.canBet && !f.canRaise)) return;
      var v=value(); if(v.error) return fail(v.error);
      var min=f.canBet?f.minBetChips:f.minRaiseToChips;
      if(v.chips>f.allInToChips) return fail('超过当前玩家筹码：最多到 ' + fmt(f.allInToChips));
      if(v.chips===f.allInToChips) return fail('这是全下金额，请点击「全下…」并再次确认');
      if(v.chips<min) return fail((f.canBet?'最小下注 ':'最小加注到 ') + fmt(min));
      act(f.canBet?'BET':'RAISE',v.chips);
    }
    function switchUnit(next) {
      if(unit===next) return;
      var v=value();
      if(v.error && amount.value.trim()) { fail('请先修正金额再切换单位：' + v.error); return; }
      unit=next; try {root.localStorage.setItem('dsh.amountUnit',unit);}catch(_){}
      if(v.chips!==undefined && facts()) fill(v.chips);
      render();
    }
    amount.onfocus=function(){amount.select();};
    amount.oninput=function(){canonical=null;canonicalText=null;updateAmount(true);};
    amount.addEventListener('compositionstart',function(){composing=true;});
    amount.addEventListener('compositionend',function(){composing=false;});
    amount.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();if(!e.repeat&&!e.isComposing&&!composing&&e.keyCode!==229)submit();}});
    $('unitChips').onclick=function(){switchUnit('CHIPS');}; $('unitBB').onclick=function(){switchUnit('BB');};
    var box=$('actionButtons'); clear(box);
    [['foldAction','弃牌',''],['callAction','过牌／跟注','call-action'],['raiseAction','确认加注','primary'],['allinAction','全下…','allin-action']].forEach(function(a){var b=el('button',a[2],a[1]);b.id=a[0];b.type='button';box.appendChild(b);});
    $('foldAction').onclick=function(){act('FOLD');};
    $('callAction').onclick=function(){var p=app.preview, b=p.actionButtons.find(function(b){return b.group==='PRIMARY'&&(b.type==='CHECK'||b.type==='CALL');});if(b)act(b.type,b.amountChips);};
    $('raiseAction').onclick=submit; $('allinAction').onclick=allin;
    document.addEventListener('keydown',function(e){
      if(e.repeat||e.isComposing||composing||e.keyCode===229)return;
      var t=e.target, editing=t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if(editing || $('overlay').className==='show' || $('tableSettings').open || !$('cardPicker').hidden)return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(!ctx.busy())$('undoBtn').click();return;}
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      if(e.key.toLowerCase()==='f'){e.preventDefault();$('foldAction').click();}
      if(e.key.toLowerCase()==='c'){e.preventDefault();$('callAction').click();}
      // Enter outside the amount field never implicitly records an action.
    });
    function render() {
      var p=app.preview,f=facts();if(!p)return;
      var key=app.state.tableId+':'+app.revision+':'+p.currentActorSeatId;
      if(key!==draftKey){draftKey=key;canonical=null;amount.value='';if(f&&(f.canBet||f.canRaise)){var min=f.canBet?f.minBetChips:f.minRaiseToChips;if(min<f.allInToChips)fill(min);}fail('');}
      $('actorLine').textContent=p.currentActorSeatId?actorText():(p.handComplete?'本手已结束':'等待公共牌或开局信息');
      $('actorLine').className=p.isHeroTurn?'hero':'';
      $('amountLabel').textContent=f&&f.canBet?'下注':'加注到';
      amount.disabled=!f||(!f.canBet&&!f.canRaise)||ctx.busy()||!!app.pendingMutation;
      $('unitChips').className=unit==='CHIPS'?'active':'';$('unitBB').className=unit==='BB'?'active':'';
      var types=p.legalActionTypes||[], locked=ctx.busy()||!!app.pendingMutation;
      $('foldAction').disabled=locked||types.indexOf('FOLD')<0;
      var cb=p.actionButtons.find(function(b){return b.group==='PRIMARY'&&(b.type==='CHECK'||b.type==='CALL');});
      $('callAction').textContent=cb?(cb.type==='CHECK'?'过牌':(cb.isAllIn?'跟注全下 ':'跟注 ')+(f?fmt(f.callChips):cb.amountBB+' BB')):'过牌／跟注';
      $('callAction').disabled=locked||!cb;
      $('raiseAction').textContent=f&&f.canBet?'确认下注 ↵':'确认加注 ↵';
      $('raiseAction').disabled=locked||!f||!(f.canBet||f.canRaise)||Math.min(f.canBet?f.minBetChips:f.minRaiseToChips,f.allInToChips)>=f.allInToChips;
      $('allinAction').disabled=locked||types.indexOf('ALL_IN')<0;
      var quick=$('sizeButtons');clear(quick);
      if(f){var seen={};(f.quickAmounts||[]).filter(function(q){return !q.isAllIn&&q.toChips<f.allInToChips;}).slice(0,7).forEach(function(q,i){if(seen[q.toChips])return;seen[q.toChips]=true;var label=i===0?'最小 ':f.canBet?q.labelZh.replace(' 底池','')+' · ':'';var b=el('button',null,label+fmt(q.toChips));b.dataset.chips=String(q.toChips);b.title=q.labelZh+'；'+q.explanationZh+'；'+(f.canBet?'下注':'加注到')+' '+q.toChips+' 筹码（只填入，不提交）';b.disabled=locked;b.onclick=function(){fill(q.toChips);};quick.appendChild(b);});}
      if(!quick.firstChild)quick.appendChild(el('span','hint','当前没有普通下注／加注尺寸'));
      $('statGrid').textContent=f?'需跟 '+fmt(f.callChips)+' · 剩余 '+fmt(f.remainingChips):'';
      var blocks=$('blockers');clear(blocks);[...new Set(p.analyzeBlockers||[])].forEach(function(t){blocks.appendChild(el('div','warn',t));});
      var history=app.state.actionHistory||[];
      $('recentActions').textContent=history.length?history.slice(-3).map(function(a){return a.position+' '+(ctx.actionZh(a.type))+(a.amountBB===undefined?'':' '+a.amountBB+'BB');}).join('　›　'):'尚未录入';
      var toggle=$('autoToggleBtn');toggle.textContent='自动分析：'+(app.autoEnabled?'开启':'关闭');toggle.setAttribute('aria-pressed',String(app.autoEnabled));
      updateAmount(false);
    }
    return {render:render,submit:submit,unit:function(){return unit;},parse:parseAmount};
  }
  root.FastInput={parseAmount:parseAmount,formatBB:formatBB,create:create};
})(typeof window==='undefined'?globalThis:window);
