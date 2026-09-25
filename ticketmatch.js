// Local, deterministic relevance heuristics. No assignment/description/call
// metadata, credential values, arbitrary payload text, or database IDs used.
const SortTicketMatch = (() => {
  const machine = value => {
    const m = String(value || '').match(/\brka-?0*(\d+)-n?0*(\d+)\b/i);
    return m ? `RKA${m[1].padStart(2,'0')}-N${m[2].padStart(4,'0')}` : '';
  };
  const stamp = value => {
    if (!value) return NaN;
    return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  };
  function boxNumber(type, box, module) {
    const raw = String(box || '').trim().toUpperCase();
    if (type === 'RKA03') return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw), max = type === 'RKA01' ? 12 : 6;
      return ['RKA01','RKA02','RKA04','RKA07'].includes(type) && n >= 1 && n <= max ? n : null;
    }
    const m = raw.match(/^([AB])([1-3])$/);
    if (!m) return null;
    if (type === 'RKA02' || type === 'RKA04') return +m[2] + (m[1] === 'B' ? 3 : 0);
    if (type === 'RKA01' && (module === 1 || module === 2)) return +m[2] + (module === 2 ? 3 : 0) + (m[1] === 'B' ? 6 : 0);
    return null;
  }
  function details(text, type, module) {
    let s = String(text || '').trim();
    if (!s) return {numbers: [], unknown: true};
    const explicit = s.match(/self\s*serving\s*(?:module\s*)?([12])/i);
    if (explicit) { module = +explicit[1]; s = s.replace(explicit[0], ''); }
    s = s.replace(/locker\s*boxes?|serving\s*boxes?|boxes|box|\bLB\b|#/gi, ' ').replace(/\b(?:and|und)\b/gi, ',');
    // Fully consumed simple lists/ranges only. Unknown prose is not a mismatch.
    if (!/^\s*(?:[AB]?\d+)(?:\s*(?:[,/+&;]|-)+\s*[AB]?\d+)*\s*$/i.test(s)) return {numbers: [], unknown: true};
    const nums = []; let unknown = false;
    for (const item of s.split(/[,/+&;]/)) {
      const range = item.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      const tokens = range && +range[2] >= +range[1] && +range[2] - +range[1] <= 12
        ? Array.from({length: +range[2] - +range[1] + 1}, (_,i) => String(+range[1]+i)) : [item.trim()];
      for (const token of tokens) { const n = boxNumber(type, token, module); if (n == null) unknown = true; else nums.push(n); }
    }
    return {numbers: [...new Set(nums)], unknown};
  }
  const components = [
    [/Serving Box|Open Box to|Locker\s*Box/i, 'Self Serving Module / Locker Box'],
    [/Cooking Zone|\bCZ\s*\d/i, 'Cooking Module / Cooking Zone'],
    [/Dishwasher/i, 'Dishwasher'], [/Bowl Dispenser/i, 'Self Serving Module / Bowl Dispenser'],
    [/Bowl Gripper/i, 'Self Serving Module / Bowl Gripper'], [/Bowl Conveyor/i, 'Self Serving Module / Bowl Conveyor'],
    [/\bFeeder\b/i, 'Storage / Feeder'], [/\bBasket\b/i, 'Storage / Basket'],
    [/\bPump\b/i, 'Storage / Pump'], [/Robot Module|Cooking Robot/i, 'Robot Module']
  ];
  function extract(session = {}) {
    const tabs = session.tabs || {}, activity = new Map(), contexts = new Map(), refs = new Set();
    function get(sys) {
      if (!activity.has(sys)) activity.set(sys, {clicks:0, parts:new Map(), errors:new Set(), boxes:new Set(), rawBoxes:new Set(), open:false});
      return activity.get(sys);
    }
    for (const e of [...(session.events || [])].sort((a,b) => (a.relativeTime || 0)-(b.relativeTime || 0))) {
      const tab = tabs[String(e.tabId)] || {}, data = e.data || {};
      const url = e.pageUrl || data.url || e.url || tab.url || '';
      let host = ''; try { host = new URL(url).hostname; } catch (_) { continue; }
      if (host === 'odoo.goodbytz.com') {
        if (e.type === 'tabNavigated') { const m = String(e.title || '').match(/\(#(\d+)\)/); if (m) refs.add(m[1]); }
        continue;
      }
      if (!host.endsWith('.goodbytz.systems')) continue;
      const sys = machine(host); if (!sys) continue;
      const a = get(sys), type = sys.split('-')[0];
      const key = `${e.tabId}:${sys}`;
      let ctx = contexts.get(key) || {module:null, box:null, part:''};
      if (e.type === 'tabNavigated' && !/self[_-]?serving/i.test(url)) { ctx = {module:null,box:null,part:''}; contexts.set(key,ctx); }
      if (e.type === 'interaction' && e.subtype === 'click') {
        a.clicks++;
        const label = String(e.actionLabel || data.control?.label || '').slice(0,1000);
        const mod = label.match(/Self Serving\s*(?:Module\s*)?([12])\b/i);
        if (mod) {ctx.module = +mod[1]; ctx.box = null;}
        else if (/click (?:card|menu-item|expansion-item):\s*(?:Modules|Self Serving|Executor Ctrl)\s*$/i.test(label)) {ctx.module=null;ctx.box=null;}
        const part = components.find(([re]) => re.test(label))?.[1];
        if (part) {a.parts.set(part, (a.parts.get(part)||0)+1);ctx.part=part;}
        const box = label.match(/(?:Serving Box|Locker\s*Box|\bbox)\s*([AB][1-3]|\d+)\b/i);
        if (box) {ctx.box=box[1].toUpperCase();a.rawBoxes.add(ctx.box);}
        if (/Start "Open Box to (?:Serve|Receive) a Dish" skill/i.test(label)) {
          a.open=true;a.parts.set('Self Serving Module / Locker Box',(a.parts.get('Self Serving Module / Locker Box')||0)+3);
          const n=boxNumber(type,ctx.box,ctx.module);if(n!=null)a.boxes.add(n);
        }
        contexts.set(key,ctx);
      }
      if (e.type === 'websocket' && e.direction === 'receive') {
        const p = String(e.payload || '');
        // Only selected UI state, not the list of all available boxes.
        if (p.startsWith('42["update",')) {
          try {
            const nodes = JSON.parse(p.slice(2))[1];
            for (const node of Object.values(nodes)) {
              if (!node || typeof node !== 'object') continue;
              if (node.tag === 'q-tree' && node.props?.selected) {
                const selected = (node.props.nodes || []).find(n => n.uuid === node.props.selected);
                const match = selected?.display_name?.match(/(?:Serving Box|Box)\s*([AB][1-3]|\d+)\b/i);
                if (match) ctx.box=match[1].toUpperCase();
              }
              const mod = String(node.text || '').match(/^Self Serving\s*([12])\s*\//i);
              if (mod) ctx.module=+mod[1];
            }
            contexts.set(key,ctx);
          } catch (_) { /* Truncated snapshots: don't guess context. */ }
        }
        for (const m of p.matchAll(/"tag"\s*:\s*"q-badge"\s*,\s*"text"\s*:\s*"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?:\s|\")/g)) a.errors.add(m[1]);
      }
    }
    const sorted=[...activity].filter(([,a])=>a.clicks).sort((a,b)=>b[1].clicks-a[1].clicks);
    const [system,a]=sorted[0] || ['',{clicks:0,parts:new Map(),errors:new Set(),boxes:new Set(),rawBoxes:new Set(),open:false}];
    const total=sorted.reduce((n,[,v])=>n+v.clicks,0);
    const part=[...a.parts].sort((x,y)=>y[1]-x[1])[0]?.[0] || '';
    return {system, strength:total ? Math.min(1,a.clicks/5)*(a.clicks/total) : 0, part,
      errors:[...a.errors], boxes:[...a.boxes], rawBoxes:[...a.rawBoxes], open:a.open,
      refs:[...refs], start:Number(session.startTime)||0, ambiguousSystem:sorted.length>1 && sorted[1][1].clicks/a.clicks>0.5};
  }
  function rank(tickets, f) {
    const type=f.system.split('-')[0];
    return tickets.map(t => {
      let score=0;const reasons=[];
      const same=!!f.system && machine(t.system)===f.system;
      if(same){score+=45*f.strength;reasons.push('System matches');}
      else if(f.system && machine(t.system)) reasons.push('Different system');
      const error=f.errors.find(e=>String(t.name).toUpperCase().split(/[^A-Z0-9_]+/).includes(e));
      const request=f.open && /^(?:request to\s+)?open\s+(?:locker\s*box|lb)\b/i.test(t.name);
      if(error){score+=30;reasons.push('Error name matches');}
      else if(request){score+=30;reasons.push('Opening request');}
      if(f.part && t.part===f.part){
        let component=15;reasons.push('Component matches');
        if(same && f.part==='Self Serving Module / Locker Box'){
          const d=details(t.detail,type,null);
          if(f.boxes.length && d.numbers.some(n=>f.boxes.includes(n))) reasons.push(`Box ${d.numbers.filter(n=>f.boxes.includes(n)).join(', ')} matches`);
          else if(f.boxes.length && d.numbers.length && !d.unknown){component-=5;reasons.push('Different box');}
          else if(t.detail)reasons.push('Box mapping uncertain');
        }
        score+=component;
      }else if(f.part && t.part && f.part.startsWith(t.part+' /')){score+=7.5;reasons.push('Parent component matches');}
      const incident=stamp(t.incident), created=stamp(t.created);
      const time=Number.isFinite(incident)?incident:created;
      if(f.start && Number.isFinite(time))score+=(Number.isFinite(incident)?10:5)/(1+Math.abs(time-f.start)/3600000);
      const explicit=f.refs.includes(t.ref);
      if(explicit)reasons.unshift('Reference observed in Odoo');
      if(!reasons.length)reasons.push('Time only / limited evidence');
      return {...t,match:{score:Math.max(0,Math.min(100,score)),reasons,explicit}};
    }).sort((a,b)=>Number(b.match.explicit)-Number(a.match.explicit)||b.match.score-a.match.score||a.ref.localeCompare(b.ref));
  }
  return {machine,stamp,boxNumber,details,extract,rank};
})();
if(typeof globalThis!=='undefined')globalThis.SortTicketMatch=SortTicketMatch;
