const COLORS = { ok:'#2F7D6D', nok:'#A6362A', rw:'#C67F22', inkFaint:'#8A94A0', panelSoft:'#F4F6F7', steel:'#2F4E62', line:'#D6DBDF' };

const ESTACIONES = ['3020EB','3020M70','3020VC','3020AC','3020STS','3020S25','3020APN','3020ET','3020M10','3020AV','3020PP'];
const CAUSAS = ['FUGA','BULONERIA','DAÑOS','DIMENSIONAL','COMPONENTE INCORRECTO','PINTURA-CINCADO','NO REGULA O CONTROLA','OTROS'];
const CAUSA_OTROS = 'OTROS';

function renderSelectOptions(selectId, options, placeholder){
  const el = document.getElementById(selectId);
  el.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + options.map(opt=>`<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
}

// ---------- form validation (real-time) ----------
function isFieldValid(id){
  const val = document.getElementById(id).value;
  if(id==='fFecha') return val !== '';
  if(id==='fProducto' || id==='fOrden') return val.trim() !== '';
  const n = Number(val);
  return val !== '' && !Number.isNaN(n) && n >= 0;
}
function updateFieldVisual(id){
  if(!touchedFields.has(id)) return;
  const el = document.getElementById(id);
  const valid = isFieldValid(id);
  el.classList.toggle('valid', valid);
  el.classList.toggle('invalid', !valid);
}
function updateCantidadCheck(){
  const hint = document.getElementById('fCantidadCheck');
  const vCantidad = document.getElementById('fCantidad').value;
  const vOk = document.getElementById('fOk').value;
  const vNok = document.getElementById('fNok').value;
  const vRw = document.getElementById('fRw').value;
  if(!vCantidad && !vOk && !vNok && !vRw){
    hint.textContent = '';
    hint.className = 'field-hint';
    return;
  }
  const suma = Number(vOk||0) + Number(vNok||0) + Number(vRw||0);
  const nCantidad = Number(vCantidad||0);
  const matches = suma === nCantidad;
  hint.textContent = matches ? `Suma OK+NOK+Retrabajo: ${suma} ✓` : `Suma OK+NOK+Retrabajo: ${suma} — no coincide con la cantidad ordenada`;
  hint.className = 'field-hint ' + (matches ? 'hint-ok' : 'hint-warn');
}
function updateSaveButtonState(){
  const allValid = REQUIRED_FIELDS.every(isFieldValid);
  const nCantidad = Number(document.getElementById('fCantidad').value||0);
  const nOk = Number(document.getElementById('fOk').value||0);
  const nNok = Number(document.getElementById('fNok').value||0);
  const nRw = Number(document.getElementById('fRw').value||0);
  const sumaOk = nCantidad === nOk+nNok+nRw;
  const causaSel = document.getElementById('fCausa').value;
  const comentarioOk = causaSel !== CAUSA_OTROS || document.getElementById('fComentarioCausa').value.trim() !== '';
  document.getElementById('saveRecordBtn').disabled = !(allValid && sumaOk && comentarioOk);
}
function handleFormFieldChange(id){
  touchedFields.add(id);
  updateFieldVisual(id);
  updateCantidadCheck();
  updateSaveButtonState();
}
function resetFormValidationState(){
  touchedFields.clear();
  REQUIRED_FIELDS.forEach(id=>document.getElementById(id).classList.remove('valid','invalid'));
  updateCantidadCheck();
  updateSaveButtonState();
}

let records = [];
let operarios = [];
let filters = { desde:'', hasta:'', producto:'todos', operario:'todos', estacion:'todos', causa:'todos' };
let groupBy = 'dia';
let activeTab = 'registro';
let gaugeChart = null;
let byEstacionChart = null;
let trendChart = null;
let paretoChart = null;
let toastTimeoutId = null;
let touchedFields = new Set();
let loadedFromDate = null;
let pendingRecord = null;
let session = null;

const REQUIRED_FIELDS = ['fProducto','fOrden','fCantidad','fOk','fNok','fRw','fFecha'];
const DEFAULT_RANGE_DAYS = 30;
const FTY_META = 95;

let previousPeriodRequestId = 0;

function todayISO(){ return new Date().toISOString().slice(0,10); }
function daysAgoISO(n){
  const d = new Date();
  d.setDate(d.getDate()-n);
  return d.toISOString().slice(0,10);
}
function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function computeFTY(ok, nok, rw){
  const total = ok+nok+rw;
  if(!total) return null;
  return (ok/total)*100;
}
function ftyTone(fty){
  if(fty===null) return { color:COLORS.inkFaint, bg:COLORS.panelSoft, label:'SIN DATOS' };
  if(fty>=95) return { color:COLORS.ok, bg:'#E4F0EC', label:'APTO' };
  if(fty>=80) return { color:COLORS.rw, bg:'#F5EAD9', label:'ACEPTABLE' };
  return { color:COLORS.nok, bg:'#F5E5E2', label:'FUERA DE RANGO' };
}
function fmtPct(v){ return v===null ? '—' : v.toFixed(1)+'%'; }
function getOperarioNombre(id){
  const op = operarios.find(o=>o.id===id);
  return op ? op.nombreCompleto : '—';
}
function showToast(msg){
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  if(toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(()=>toast.classList.remove('show'), 2500);
}

// ---------- storage (Supabase) ----------
function mapRecordFromDb(row){
  return {
    id: row.id,
    ordenTrabajo: row.orden_trabajo,
    codigoProducto: row.codigo_producto,
    cantidad: row.cantidad,
    fecha: row.fecha,
    operarioId: row.operario_id,
    ok: row.ok,
    nok: row.nok,
    rw: row.rw,
    estacionArmado: row.estacion_armado || [],
    causaNokRetrabajo: row.causa_nok_retrabajo || [],
    comentarioCausa: row.comentario_causa || '',
  };
}
function mapRecordToDb(record){
  return {
    orden_trabajo: record.ordenTrabajo,
    codigo_producto: record.codigoProducto,
    cantidad: record.cantidad,
    fecha: record.fecha,
    operario_id: record.operarioId,
    ok: record.ok,
    nok: record.nok,
    rw: record.rw,
    estacion_armado: record.estacionArmado,
    causa_nok_retrabajo: record.causaNokRetrabajo,
    comentario_causa: record.comentarioCausa || null,
  };
}
function mapOperarioFromDb(row){
  return { id: row.id, nombreCompleto: row.nombre_completo };
}

async function loadOperarios(){
  const errBanner = document.getElementById('saveError');
  try{
    const { data, error } = await supabaseClient.from('operarios').select('id, nombre_completo').eq('activo', true).order('nombre_completo');
    if(error) throw error;
    operarios = (data||[]).map(mapOperarioFromDb);
  }catch(e){
    operarios = [];
    errBanner.textContent = 'No se pudo cargar la lista de operarios. Recargá la página.';
    errBanner.classList.remove('hidden');
  }
  renderAll();
}

async function loadRecords(fromDate){
  const wrap = document.getElementById('tableWrap');
  const errBanner = document.getElementById('saveError');
  wrap.innerHTML = '<div class="loading-msg">Cargando registros…</div>';
  try{
    const { data, error } = await supabaseClient.from('records').select('*').gte('fecha', fromDate).order('created_at', { ascending:true });
    if(error) throw error;
    records = (data||[]).map(mapRecordFromDb);
    loadedFromDate = fromDate;
    errBanner.classList.add('hidden');
  }catch(e){
    records = [];
    loadedFromDate = fromDate;
    errBanner.textContent = 'No se pudo conectar con la base de datos. Verificá tu conexión e intentá recargar la página.';
    errBanner.classList.remove('hidden');
  }
  renderAll();
}

async function insertRecord(record){
  const errBanner = document.getElementById('saveError');
  try{
    const { data, error } = await supabaseClient.from('records').insert(mapRecordToDb(record)).select();
    if(error) throw error;
    const inserted = data && data[0] ? mapRecordFromDb(data[0]) : record;
    records = [inserted, ...records];
    errBanner.classList.add('hidden');
    renderAll();
    return true;
  }catch(e){
    if(e && e.code==='23505'){
      errBanner.textContent = 'Esa orden de trabajo ya fue cargada.';
    }else if(e && e.code==='23514'){
      errBanner.textContent = 'La cantidad debe ser igual a OK + NOK + Retrabajo.';
    }else{
      errBanner.textContent = 'No se pudo guardar — revisá la conexión e intentá de nuevo.';
    }
    errBanner.classList.remove('hidden');
    return false;
  }
}

// ---------- confirm modal ----------
function buildModalSummary(record){
  const estaciones = record.estacionArmado.length ? record.estacionArmado.join(', ') : '—';
  const causas = record.causaNokRetrabajo.length ? record.causaNokRetrabajo.join(', ') : '—';
  document.getElementById('modalSummary').innerHTML = `
    <dl>
      <dt>Orden de trabajo</dt><dd>${escapeHtml(record.ordenTrabajo)}</dd>
      <dt>Producto</dt><dd>${escapeHtml(record.codigoProducto)}</dd>
      <dt>Cantidad</dt><dd>${record.cantidad}</dd>
      <dt>OK</dt><dd>${record.ok}</dd>
      <dt>NOK</dt><dd>${record.nok}</dd>
      <dt>Retrabajo</dt><dd>${record.rw}</dd>
      <dt>Operario</dt><dd>${escapeHtml(getOperarioNombre(record.operarioId))}</dd>
      <dt>Fecha</dt><dd>${escapeHtml(record.fecha)}</dd>
      <dt>Estación de armado</dt><dd>${escapeHtml(estaciones)}</dd>
      <dt>Causa NOK-Retrabajo</dt><dd>${escapeHtml(causas)}</dd>
    </dl>
  `;
}
function openConfirmModal(record){
  pendingRecord = record;
  buildModalSummary(record);
  document.getElementById('confirmModal').classList.remove('hidden');
}
function closeConfirmModal(){
  document.getElementById('confirmModal').classList.add('hidden');
  pendingRecord = null;
}

// ---------- derived data ----------
function matchesNonDateFilters(r){
  if(filters.producto!=='todos' && r.codigoProducto!==filters.producto) return false;
  if(filters.operario!=='todos' && r.operarioId!==filters.operario) return false;
  if(filters.estacion!=='todos' && !(r.estacionArmado||[]).includes(filters.estacion)) return false;
  if(filters.causa!=='todos' && !(r.causaNokRetrabajo||[]).includes(filters.causa)) return false;
  return true;
}
function getFiltered(){
  return records.filter(r=>{
    if(filters.desde && r.fecha < filters.desde) return false;
    if(filters.hasta && r.fecha > filters.hasta) return false;
    return matchesNonDateFilters(r);
  });
}
function getPreviousPeriodRange(){
  const desde = filters.desde;
  const hasta = filters.hasta || todayISO();
  if(!desde) return null;
  const desdeDate = new Date(desde+'T00:00:00');
  const hastaDate = new Date(hasta+'T00:00:00');
  const daysSpan = Math.round((hastaDate - desdeDate) / 86400000) + 1;
  if(daysSpan <= 0) return null;
  const prevHastaDate = new Date(desdeDate);
  prevHastaDate.setDate(prevHastaDate.getDate() - 1);
  const prevDesdeDate = new Date(prevHastaDate);
  prevDesdeDate.setDate(prevDesdeDate.getDate() - (daysSpan - 1));
  return { desde: prevDesdeDate.toISOString().slice(0,10), hasta: prevHastaDate.toISOString().slice(0,10) };
}
function getOverall(filtered){
  const s = filtered.reduce((acc,r)=>({ok:acc.ok+r.ok, nok:acc.nok+r.nok, rw:acc.rw+r.rw}), {ok:0,nok:0,rw:0});
  return { ...s, fty: computeFTY(s.ok,s.nok,s.rw), total: s.ok+s.nok+s.rw };
}
function getByEstacion(filtered){
  const map = {};
  filtered.forEach(r=>{
    (r.estacionArmado||[]).forEach(est=>{
      if(!map[est]) map[est] = {ok:0,nok:0,rw:0};
      map[est].ok += r.ok; map[est].nok += r.nok; map[est].rw += r.rw;
    });
  });
  return Object.entries(map).map(([estacion,s])=>({ estacion, fty: computeFTY(s.ok,s.nok,s.rw) ?? 0 })).sort((a,b)=>a.fty-b.fty);
}
function getByPeriod(filtered){
  const bucket = f => groupBy==='anio' ? f.slice(0,4) : groupBy==='mes' ? f.slice(0,7) : f;
  const map = {};
  filtered.forEach(r=>{
    const k = bucket(r.fecha);
    if(!map[k]) map[k] = {ok:0,nok:0,rw:0};
    map[k].ok += r.ok; map[k].nok += r.nok; map[k].rw += r.rw;
  });
  return Object.entries(map).map(([periodo,s])=>({ periodo, fty: computeFTY(s.ok,s.nok,s.rw) ?? 0 })).sort((a,b)=>a.periodo.localeCompare(b.periodo));
}
function getCausaPareto(filtered){
  const counts = {};
  CAUSAS.forEach(c=>counts[c]=0);
  filtered.forEach(r=>{
    (r.causaNokRetrabajo||[]).forEach(c=>{ if(counts[c]!==undefined) counts[c]++; });
  });
  const rows = CAUSAS.map(c=>({ causa:c, count:counts[c] })).filter(r=>r.count>0).sort((a,b)=>b.count-a.count);
  const total = rows.reduce((s,r)=>s+r.count, 0);
  let acc = 0;
  return rows.map(r=>{
    acc += r.count;
    return { causa:r.causa, count:r.count, pctAcum: total ? (acc/total*100) : 0 };
  });
}

// ---------- gauge (ECharts) ----------
function renderGauge(value, sublabel){
  const hasValue = value!==null;
  const tone = ftyTone(value);

  document.getElementById('gaugeWrap').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div id="gaugeChart" style="width:260px;height:265px;"></div>
      <div class="gauge-status" style="background:${tone.bg};color:${tone.color};">${tone.label}</div>
      ${sublabel ? `<div class="gauge-sublabel">${escapeHtml(sublabel)}</div>` : ''}
      <div class="gauge-comparison" id="gaugeComparison"></div>
    </div>
  `;
  if(gaugeChart){ gaugeChart.dispose(); gaugeChart=null; }
  gaugeChart = echarts.init(document.getElementById('gaugeChart'));
  gaugeChart.setOption({
    series: [{
      type: 'gauge',
      startAngle: 180,
      endAngle: 0,
      min: 0,
      max: 100,
      center: ['50%', '78%'],
      radius: '105%',
      splitNumber: 5,
      axisLine: {
        lineStyle: {
          width: 14,
          color: [[0.8, COLORS.nok], [0.95, COLORS.rw], [1, COLORS.ok]],
        }
      },
      pointer: { length: '55%', width: 5, itemStyle: { color: COLORS.steel } },
      anchor: { show: true, size: 12, itemStyle: { color: COLORS.steel } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      title: {
        show: true,
        offsetCenter: [0, '25%'],
        fontSize: 11,
        fontFamily: "'Oswald',sans-serif",
        color: '#5B6773',
      },
      detail: {
        valueAnimation: true,
        offsetCenter: [0, '-5%'],
        fontSize: 30,
        fontWeight: 600,
        fontFamily: "'IBM Plex Mono',monospace",
        color: '#16212B',
        formatter: () => hasValue ? value.toFixed(1) : '—',
      },
      data: [{ value: hasValue ? value : 0, name: '% FTY' }],
    }]
  });

  renderPreviousPeriodComparison(hasValue ? value : null);
}

async function renderPreviousPeriodComparison(currentFty){
  const el = document.getElementById('gaugeComparison');
  const range = getPreviousPeriodRange();
  if(!range){
    el.textContent = '';
    return;
  }
  const myRequestId = ++previousPeriodRequestId;
  el.textContent = 'Calculando comparación con el período anterior…';
  el.className = 'gauge-comparison';

  let prevOverall = null;
  try{
    const { data, error } = await supabaseClient.from('records').select('*').gte('fecha', range.desde).lte('fecha', range.hasta);
    if(error) throw error;
    const prevRecords = (data||[]).map(mapRecordFromDb).filter(matchesNonDateFilters);
    prevOverall = getOverall(prevRecords);
  }catch(e){
    prevOverall = null;
  }

  if(myRequestId !== previousPeriodRequestId) return;

  if(currentFty===null || !prevOverall || prevOverall.fty===null){
    el.textContent = 'Sin datos del período anterior para comparar';
    el.className = 'gauge-comparison gauge-comparison-muted';
    return;
  }

  const delta = currentFty - prevOverall.fty;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const toneClass = delta > 0 ? 'gauge-comparison-up' : delta < 0 ? 'gauge-comparison-down' : 'gauge-comparison-neutral';
  const sign = delta > 0 ? '+' : '';
  el.innerHTML = `<span class="${toneClass}">${arrow} ${sign}${delta.toFixed(1)} pts</span> vs. período anterior`;
  el.className = 'gauge-comparison';
}

// ---------- render: filters options ----------
function renderFilterOptions(){
  const productos = [...new Set(records.map(r=>r.codigoProducto))].sort();
  const pSel = document.getElementById('filterProducto');
  const oSel = document.getElementById('filterOperario');
  const eSel = document.getElementById('filterEstacion');
  const cSel = document.getElementById('filterCausa');
  const curP = pSel.value, curO = oSel.value;
  pSel.innerHTML = '<option value="todos">Todos</option>' + productos.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  oSel.innerHTML = '<option value="todos">Todos</option>' + operarios.map(o=>`<option value="${escapeHtml(o.id)}">${escapeHtml(o.nombreCompleto)}</option>`).join('');
  if(eSel.options.length <= 1){
    eSel.innerHTML = '<option value="todos">Todas</option>' + ESTACIONES.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  }
  if(cSel.options.length <= 1){
    cSel.innerHTML = '<option value="todos">Todas</option>' + CAUSAS.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }
  pSel.value = productos.includes(curP) ? curP : 'todos';
  oSel.value = operarios.some(o=>o.id===curO) ? curO : 'todos';

  const isDefaultRange = filters.desde===daysAgoISO(DEFAULT_RANGE_DAYS) && filters.hasta===todayISO();
  const anyFilter = !isDefaultRange || filters.producto!=='todos' || filters.operario!=='todos' || filters.estacion!=='todos' || filters.causa!=='todos';
  document.getElementById('clearFiltersBtn').classList.toggle('hidden', !anyFilter);
}

// ---------- render: table ----------
function renderTable(filtered){
  const sorted = [...filtered].sort((a,b)=> a.fecha < b.fecha ? 1 : -1);
  document.getElementById('historialLabel').textContent = `HISTORIAL DE LOTES (${sorted.length})`;
  document.getElementById('exportXlsBtn').disabled = sorted.length===0;
  const wrap = document.getElementById('tableWrap');
  if(sorted.length===0){
    wrap.innerHTML = '<div class="empty-msg">Sin registros aún. Cargá el primer lote de producción con el botón de arriba.</div>';
    return;
  }
  const rows = sorted.map((r,i)=>{
    const fty = computeFTY(r.ok,r.nok,r.rw);
    const tone = ftyTone(fty);
    const estaciones = (r.estacionArmado||[]).map(e=>`<span class="tag">${escapeHtml(e)}</span>`).join('');
    const causas = (r.causaNokRetrabajo||[]).map(c=>`<span class="tag">${escapeHtml(c)}</span>`).join('');
    return `<tr class="${i%2 ? 'odd':''}">
      <td class="mono">${escapeHtml(r.ordenTrabajo)}</td>
      <td class="mono">${escapeHtml(r.codigoProducto)}</td>
      <td class="mono">${escapeHtml(r.fecha)}</td>
      <td>${escapeHtml(getOperarioNombre(r.operarioId))}</td>
      <td class="mono">${r.cantidad}</td>
      <td class="mono" style="color:${COLORS.ok}">${r.ok}</td>
      <td class="mono" style="color:${COLORS.nok}">${r.nok}</td>
      <td class="mono" style="color:${COLORS.rw}">${r.rw}</td>
      <td class="mono" style="font-weight:600;color:${tone.color}">${fmtPct(fty)}</td>
      <td><div class="tag-list">${estaciones || '—'}</div></td>
      <td><div class="tag-list">${causas || '—'}</div></td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `<div style="overflow-x:auto;"><table>
    <thead><tr>${['Orden','Producto','Fecha','Operario','Cant.','OK','NOK','Retrab.','FTY','Estación de armado','Causa NOK-Retrabajo'].map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ---------- render: stats ----------
function renderStats(overall){
  document.getElementById('statsGrid').innerHTML = `
    <div><div class="stat-label">OK</div><div class="stat-value" style="color:${COLORS.ok}">${overall.ok}</div></div>
    <div><div class="stat-label">NOK</div><div class="stat-value" style="color:${COLORS.nok}">${overall.nok}</div></div>
    <div><div class="stat-label">RETRABAJO</div><div class="stat-value" style="color:${COLORS.rw}">${overall.rw}</div></div>
  `;
}

// ---------- render: charts (ECharts) ----------
function renderByEstacionChart(data){
  const wrap = document.getElementById('byEstacionWrap');
  if(data.length===0){
    if(byEstacionChart){ byEstacionChart.dispose(); byEstacionChart=null; }
    wrap.innerHTML = '<div class="empty-chart">No hay datos para los filtros actuales.</div>';
    return;
  }
  const height = Math.max(180, data.length*40);
  wrap.style.height = height+'px';
  if(byEstacionChart){ byEstacionChart.dispose(); byEstacionChart=null; }
  wrap.innerHTML = `<div id="byEstacionChart" style="width:100%;height:100%;"></div>`;
  byEstacionChart = echarts.init(document.getElementById('byEstacionChart'));
  byEstacionChart.setOption({
    grid: { left: 70, right: 30, top: 10, bottom: 24 },
    tooltip: { trigger:'axis', axisPointer:{type:'shadow'}, formatter: p => `${p[0].name}: ${p[0].value.toFixed(1)}%` },
    xAxis: {
      type:'value', min:0, max:100,
      axisLabel:{ formatter:'{value}%', fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#5B6773' },
      splitLine:{ lineStyle:{ color:'#D6DBDF' } },
    },
    yAxis: {
      type:'category',
      data: data.map(d=>d.estacion),
      axisLabel:{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#16212B' },
      axisLine:{ show:false },
      axisTick:{ show:false },
    },
    series: [{
      type:'bar',
      data: data.map(d=>({ value: d.fty, itemStyle: { color: ftyTone(d.fty).color, borderRadius: [0,3,3,0] } })),
      barMaxWidth: 22,
    }]
  });
}
function renderParetoChart(data){
  const wrap = document.getElementById('paretoWrap');
  if(data.length===0){
    if(paretoChart){ paretoChart.dispose(); paretoChart=null; }
    wrap.innerHTML = '<div class="empty-chart">No hay datos para los filtros actuales.</div>';
    return;
  }
  if(paretoChart){ paretoChart.dispose(); paretoChart=null; }
  wrap.innerHTML = `<div id="paretoChart" style="width:100%;height:100%;"></div>`;
  paretoChart = echarts.init(document.getElementById('paretoChart'));
  const maxCount = Math.max(...data.map(d=>d.count));
  const countAxisMax = Math.max(5, Math.ceil(maxCount * 1.2));
  paretoChart.setOption({
    grid: { left: 45, right: 45, top: 40, bottom: 64 },
    legend: { top: 0, textStyle: { fontFamily:"'Inter',sans-serif", fontSize:11, color:'#5B6773' } },
    tooltip: { trigger:'axis' },
    xAxis: {
      type:'category', data: data.map(d=>d.causa),
      axisLabel:{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#5B6773', interval:0, rotate:20 },
      axisLine:{ lineStyle:{ color:'#D6DBDF' } }, axisTick:{ show:false },
    },
    yAxis: [
      { type:'value', name:'Cantidad', min:0, max:countAxisMax, axisLabel:{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#5B6773' }, splitLine:{ lineStyle:{ color:'#D6DBDF' } } },
      { type:'value', name:'% acumulado', min:0, max:100, axisLabel:{ formatter:'{value}%', fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#5B6773' }, splitLine:{ show:false } },
    ],
    series: [
      { type:'bar', name:'Cantidad', data: data.map(d=>d.count), itemStyle:{ color: COLORS.rw, borderRadius:[3,3,0,0] }, barMaxWidth:40, yAxisIndex:0 },
      { type:'line', name:'% acumulado', data: data.map(d=>Number(d.pctAcum.toFixed(1))), yAxisIndex:1, itemStyle:{ color:COLORS.steel }, lineStyle:{ color:COLORS.steel, width:2 }, symbolSize:7 },
    ]
  });
}
function renderTrendChart(data){
  const wrap = document.getElementById('trendWrap');
  if(data.length===0){
    if(trendChart){ trendChart.dispose(); trendChart=null; }
    wrap.innerHTML = '<div class="empty-chart">No hay datos para los filtros actuales.</div>';
    return;
  }
  if(trendChart){ trendChart.dispose(); trendChart=null; }
  wrap.innerHTML = `<div id="trendChart" style="width:100%;height:100%;"></div>`;
  trendChart = echarts.init(document.getElementById('trendChart'));
  trendChart.setOption({
    grid: { left: 45, right: 20, top: 16, bottom: 30 },
    tooltip: { trigger:'axis', formatter: p => `${p[0].name}: ${p[0].value.toFixed(1)}%` },
    xAxis: {
      type:'category', data: data.map(d=>d.periodo),
      axisLabel:{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#5B6773' },
      axisLine:{ lineStyle:{ color:'#D6DBDF' } }, axisTick:{ show:false },
    },
    yAxis: {
      type:'value', min:0, max:100,
      axisLabel:{ formatter:'{value}%', fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#5B6773' },
      splitLine:{ lineStyle:{ color:'#D6DBDF' } },
    },
    series: [{
      type:'line',
      data: data.map(d=>Number(d.fty.toFixed(1))),
      itemStyle:{ color:COLORS.steel }, lineStyle:{ color:COLORS.steel, width:2 }, symbolSize:6, smooth:0.15,
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: COLORS.inkFaint, type: 'dashed', width: 1.5 },
        label: { formatter: `Meta: ${FTY_META}%`, position: 'insideEndTop', color: COLORS.inkFaint, fontFamily:"'Inter',sans-serif", fontSize: 11 },
        data: [{ yAxis: FTY_META }],
      },
    }]
  });
}

window.addEventListener('resize', ()=>{
  [gaugeChart, byEstacionChart, paretoChart, trendChart].forEach(c=>{ if(c) c.resize(); });
});

// ---------- master render ----------
function renderAll(){
  renderFilterOptions();
  const filtered = getFiltered();
  renderTable(filtered);

  if(activeTab==='panel'){
    const overall = getOverall(filtered);
    renderGauge(overall.fty, `${overall.total} unidades evaluadas`);
    renderStats(overall);
    renderByEstacionChart(getByEstacion(filtered));
    renderParetoChart(getCausaPareto(filtered));
    renderTrendChart(getByPeriod(filtered));
  }
}

// ---------- events ----------
document.getElementById('tabRegistroBtn').addEventListener('click', ()=>{
  activeTab='registro';
  document.getElementById('tabRegistroBtn').classList.add('active');
  document.getElementById('tabPanelBtn').classList.remove('active');
  document.getElementById('registroView').classList.remove('hidden');
  document.getElementById('panelView').classList.add('hidden');
  requestAnimationFrame(()=>document.getElementById('fProducto').focus());
});
document.getElementById('tabPanelBtn').addEventListener('click', ()=>{
  activeTab='panel';
  document.getElementById('tabPanelBtn').classList.add('active');
  document.getElementById('tabRegistroBtn').classList.remove('active');
  document.getElementById('panelView').classList.remove('hidden');
  document.getElementById('registroView').classList.add('hidden');
  renderAll();
});

document.getElementById('fCausa').addEventListener('change', ()=>{
  const otros = document.getElementById('fCausa').value === CAUSA_OTROS;
  document.getElementById('fComentarioCausaWrap').classList.toggle('hidden', !otros);
  if(!otros) document.getElementById('fComentarioCausa').value = '';
  updateSaveButtonState();
});
document.getElementById('fComentarioCausa').addEventListener('input', updateSaveButtonState);

document.getElementById('saveRecordBtn').addEventListener('click', ()=>{
  const ordenTrabajo = document.getElementById('fOrden').value.trim();
  const codigoProducto = document.getElementById('fProducto').value.trim().toUpperCase();
  const cantidad = document.getElementById('fCantidad').value;
  const fecha = document.getElementById('fFecha').value;
  const operarioId = session.operarioId;
  const ok = document.getElementById('fOk').value;
  const nok = document.getElementById('fNok').value;
  const rw = document.getElementById('fRw').value;
  const estacionSel = document.getElementById('fEstacion').value;
  const causaSel = document.getElementById('fCausa').value;
  const estacionArmado = estacionSel ? [estacionSel] : [];
  const causaNokRetrabajo = causaSel ? [causaSel] : [];
  const comentarioCausa = document.getElementById('fComentarioCausa').value.trim();

  const errEl = document.getElementById('formError');
  if(!ordenTrabajo || !codigoProducto || !fecha || !operarioId){
    errEl.textContent = 'Completá orden de trabajo, código de producto, fecha y operario.';
    errEl.classList.remove('hidden');
    return;
  }
  const nCantidad = Number(cantidad||0), nOk = Number(ok||0), nNok = Number(nok||0), nRw = Number(rw||0);
  if([nCantidad,nOk,nNok,nRw].some(n => Number.isNaN(n) || n<0)){
    errEl.textContent = 'Las cantidades tienen que ser números mayores o iguales a 0.';
    errEl.classList.remove('hidden');
    return;
  }
  if(nCantidad !== nOk+nNok+nRw){
    errEl.textContent = 'La cantidad debe ser igual a OK + NOK + Retrabajo.';
    errEl.classList.remove('hidden');
    return;
  }
  if(causaNokRetrabajo.includes(CAUSA_OTROS) && !comentarioCausa){
    errEl.textContent = 'Ingresá un comentario para la causa "Otros".';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const record = {
    ordenTrabajo, codigoProducto, cantidad:nCantidad, fecha, operarioId, ok:nOk, nok:nNok, rw:nRw,
    estacionArmado, causaNokRetrabajo,
    comentarioCausa: causaNokRetrabajo.includes(CAUSA_OTROS) ? comentarioCausa : '',
  };
  openConfirmModal(record);
});

document.getElementById('modalCancelBtn').addEventListener('click', closeConfirmModal);

document.getElementById('modalConfirmBtn').addEventListener('click', async ()=>{
  if(!pendingRecord) return;
  const record = pendingRecord;
  const confirmBtn = document.getElementById('modalConfirmBtn');
  confirmBtn.disabled = true;
  const saved = await insertRecord(record);
  confirmBtn.disabled = false;
  if(!saved){
    closeConfirmModal();
    updateSaveButtonState();
    return;
  }

  closeConfirmModal();
  showToast(`Lote ${record.ordenTrabajo} guardado correctamente`);

  ['fOrden','fProducto','fCantidad','fOk','fNok','fRw','fComentarioCausa','fEstacion','fCausa'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('fComentarioCausaWrap').classList.add('hidden');
  document.getElementById('fFecha').value = todayISO();
  document.getElementById('fFecha').max = todayISO();
  resetFormValidationState();
  document.getElementById('fProducto').focus();
});

['filterDesde','filterHasta','filterProducto','filterOperario','filterEstacion','filterCausa'].forEach(id=>{
  document.getElementById(id).addEventListener('change', async (e)=>{
    const key = id.replace('filter','').toLowerCase();
    filters[key] = e.target.value;
    if(key==='desde' && filters.desde && (!loadedFromDate || filters.desde < loadedFromDate)){
      await loadRecords(filters.desde);
    }else{
      renderAll();
    }
  });
});
document.getElementById('clearFiltersBtn').addEventListener('click', async ()=>{
  const desde30 = daysAgoISO(DEFAULT_RANGE_DAYS), hoy = todayISO();
  filters = { desde:desde30, hasta:hoy, producto:'todos', operario:'todos', estacion:'todos', causa:'todos' };
  document.getElementById('filterDesde').value = desde30;
  document.getElementById('filterHasta').value = hoy;
  document.getElementById('filterProducto').value='todos';
  document.getElementById('filterOperario').value='todos';
  document.getElementById('filterEstacion').value='todos';
  document.getElementById('filterCausa').value='todos';
  if(!loadedFromDate || desde30 < loadedFromDate){
    await loadRecords(desde30);
  }else{
    renderAll();
  }
});

document.getElementById('exportXlsBtn').addEventListener('click', ()=>{
  const filtered = getFiltered();
  if(filtered.length===0) return;
  const sorted = [...filtered].sort((a,b)=> a.fecha < b.fecha ? 1 : -1);
  const rows = sorted.map(r=>{
    const fty = computeFTY(r.ok, r.nok, r.rw);
    return {
      'N° orden de trabajo': r.ordenTrabajo,
      'Código de producto': r.codigoProducto,
      'Fecha de producción': r.fecha,
      'Operario': getOperarioNombre(r.operarioId),
      'Cantidad ordenada': r.cantidad,
      'Cantidad OK': r.ok,
      'Cantidad NOK': r.nok,
      'Cantidad retrabajo': r.rw,
      'FTY (%)': fty===null ? '' : Number(fty.toFixed(1)),
      'Estación de armado': (r.estacionArmado||[]).join(', '),
      'Causa NOK-Retrabajo': (r.causaNokRetrabajo||[]).join(', '),
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [ {wch:18}, {wch:18}, {wch:16}, {wch:20}, {wch:14}, {wch:12}, {wch:12}, {wch:14}, {wch:10}, {wch:24}, {wch:28} ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Registros');
  const stamp = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `registros_produccion_${stamp}.xlsx`);
});

function addChartImageSection(doc, chart, title, marginX, y, maxWidthMm, pageHeight, marginBottom){
  if(y > pageHeight - marginBottom - 20){ doc.addPage(); y = 18; }
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(22,33,43);
  doc.text(title, marginX, y);
  y += 6;
  if(!chart){
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(138,148,160);
    doc.text('Sin datos para este gráfico con los filtros actuales.', marginX, y);
    return y + 10;
  }
  const pxW = chart.getWidth(), pxH = chart.getHeight();
  const imgW = maxWidthMm;
  const imgH = imgW * (pxH / pxW);
  if(y + imgH > pageHeight - marginBottom){ doc.addPage(); y = 18; }
  const dataUrl = chart.getDataURL({ type:'png', pixelRatio:2, backgroundColor:'#fff' });
  doc.addImage(dataUrl, 'PNG', marginX, y, imgW, imgH);
  return y + imgH + 10;
}

function exportPanelPDF(){
  const filtered = getFiltered();
  if(filtered.length===0){
    const errBanner = document.getElementById('saveError');
    errBanner.textContent = 'No hay datos para exportar con los filtros actuales.';
    errBanner.classList.remove('hidden');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 16;
  const contentWidth = pageWidth - marginX*2;
  let y = 18;

  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(30,53,66);
  doc.text('Reporte de Producción — Control de Calidad, Armado de Válvulas', marginX, y, { maxWidth: contentWidth });
  y += 9;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(91,103,115);
  const now = new Date();
  doc.text(`Generado el ${now.toLocaleDateString('es-AR')} a las ${now.toLocaleTimeString('es-AR')}`, marginX, y);
  y += 8;

  doc.setDrawColor(214,219,223);
  doc.line(marginX, y, pageWidth-marginX, y);
  y += 9;

  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(22,33,43);
  doc.text('Filtros aplicados', marginX, y);
  y += 6;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(22,33,43);
  const filtroProducto = filters.producto==='todos' ? 'Todos' : filters.producto;
  const filtroOperario = filters.operario==='todos' ? 'Todos' : getOperarioNombre(filters.operario);
  const filtroEstacion = filters.estacion==='todos' ? 'Todas' : filters.estacion;
  const filtroCausa = filters.causa==='todos' ? 'Todas' : filters.causa;
  [
    `Rango de fechas: ${filters.desde || '—'} a ${filters.hasta || '—'}`,
    `Producto: ${filtroProducto}`,
    `Operario: ${filtroOperario}`,
    `Estación de armado: ${filtroEstacion}`,
    `Causa NOK-Retrabajo: ${filtroCausa}`,
  ].forEach(line=>{ doc.text(line, marginX, y); y += 5.5; });
  y += 6;

  const overall = getOverall(filtered);
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(22,33,43);
  doc.text('FTY general', marginX, y);
  y += 6;
  const gaugeSectionTop = y;
  let gaugeImgH = 0;
  if(gaugeChart){
    const pxW = gaugeChart.getWidth(), pxH = gaugeChart.getHeight();
    const imgW = 70;
    gaugeImgH = imgW * (pxH/pxW);
    const dataUrl = gaugeChart.getDataURL({ type:'png', pixelRatio:2, backgroundColor:'#fff' });
    doc.addImage(dataUrl, 'PNG', marginX, y, imgW, gaugeImgH);
  }
  const statsX = marginX + 78;
  let statsY = gaugeSectionTop + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(22,33,43);
  doc.text(`FTY: ${fmtPct(overall.fty)}`, statsX, statsY); statsY += 6.5;
  doc.text(`OK: ${overall.ok}`, statsX, statsY); statsY += 6.5;
  doc.text(`NOK: ${overall.nok}`, statsX, statsY); statsY += 6.5;
  doc.text(`Retrabajo: ${overall.rw}`, statsX, statsY); statsY += 8;
  const comparisonEl = document.getElementById('gaugeComparison');
  const comparisonText = comparisonEl ? comparisonEl.textContent.trim() : '';
  if(comparisonText){
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(91,103,115);
    const lines = doc.splitTextToSize(comparisonText, pageWidth - statsX - marginX);
    doc.text(lines, statsX, statsY);
    statsY += lines.length * 4.5;
  }
  y = gaugeSectionTop + Math.max(gaugeImgH, statsY - gaugeSectionTop) + 8;

  y = addChartImageSection(doc, byEstacionChart, 'FTY por estación de armado', marginX, y, contentWidth, pageHeight, 18);
  y = addChartImageSection(doc, trendChart, 'Tendencia de FTY', marginX, y, contentWidth, pageHeight, 18);
  y = addChartImageSection(doc, paretoChart, 'Causas NOK-Retrabajo (Pareto)', marginX, y, contentWidth, pageHeight, 18);

  doc.save(`reporte-fty-${todayISO()}.pdf`);
}

document.getElementById('exportPdfBtn').addEventListener('click', exportPanelPDF);

document.getElementById('groupByToggle').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-g]');
  if(!btn) return;
  groupBy = btn.getAttribute('data-g');
  document.querySelectorAll('#groupByToggle .toggle').forEach(b=>b.classList.toggle('active', b===btn));
  renderAll();
});

['fProducto','fOrden','fCantidad','fOk','fNok','fRw','fFecha'].forEach(id=>{
  const el = document.getElementById(id);
  el.addEventListener('input', ()=>handleFormFieldChange(id));
  el.addEventListener('blur', ()=>handleFormFieldChange(id));
});

renderSelectOptions('fEstacion', ESTACIONES, 'Seleccioná una estación');
renderSelectOptions('fCausa', CAUSAS, 'Seleccioná una causa');
document.getElementById('fFecha').value = todayISO();
document.getElementById('fFecha').max = todayISO();
updateSaveButtonState();

const initialDesde = daysAgoISO(DEFAULT_RANGE_DAYS), initialHasta = todayISO();
filters.desde = initialDesde;
filters.hasta = initialHasta;
document.getElementById('filterDesde').value = initialDesde;
document.getElementById('filterHasta').value = initialHasta;

loadOperarios();
loadRecords(initialDesde);

// ---------- auth / session ----------
function enterApp(){
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appRoot').classList.remove('hidden');
  document.getElementById('sessionUserDisplay').textContent = session.nombreCompleto;
  requestAnimationFrame(()=>document.getElementById('fProducto').focus());
}
function showLoginScreen(){
  document.getElementById('appRoot').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginLegajo').value = '';
  document.getElementById('loginPin').value = '';
  document.getElementById('loginError').classList.add('hidden');
  requestAnimationFrame(()=>document.getElementById('loginLegajo').focus());
}

async function attemptLogin(){
  const legajo = document.getElementById('loginLegajo').value.trim().toUpperCase().replace(/\s+/g,'');
  const pin = document.getElementById('loginPin').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  if(!legajo || !pin){
    errEl.textContent = 'Usuario o contraseña incorrectos.';
    errEl.classList.remove('hidden');
    return;
  }
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = true;
  try{
    const { data, error } = await supabaseClient.rpc('login_operario', { p_legajo: legajo, p_pin: pin });
    if(error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if(!row){
      errEl.textContent = 'Usuario o contraseña incorrectos.';
      errEl.classList.remove('hidden');
    }else{
      session = { operarioId: row.operario_id || row.id, nombreCompleto: row.nombre_completo };
      sessionStorage.setItem('session', JSON.stringify(session));
      enterApp();
    }
  }catch(e){
    errEl.textContent = 'Usuario o contraseña incorrectos.';
    errEl.classList.remove('hidden');
  }
  loginBtn.disabled = false;
}

document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('loginPin').addEventListener('keydown', (e)=>{
  if(e.key==='Enter') attemptLogin();
});

document.getElementById('logoutBtn').addEventListener('click', ()=>{
  sessionStorage.removeItem('session');
  session = null;
  showLoginScreen();
});

const storedSession = sessionStorage.getItem('session');
if(storedSession){
  try{
    session = JSON.parse(storedSession);
    enterApp();
  }catch(e){
    showLoginScreen();
  }
}else{
  showLoginScreen();
}
