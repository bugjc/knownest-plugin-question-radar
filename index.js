'use strict'

/**
 * question-radar 题源雷达（题库扩充批次 C，2026-09-25 迭代计划 §4）
 *
 * 管什么：为「0 覆盖/薄弱」知识点采集网络材料并落库，交给出题官接地出题——
 *   选题（未覆盖/薄弱 KP TopN，日预算 + 7 天冷却）→ 搜材料（ctx.web.search → read，
 *   支持 materials 注入通道供探针/agent 直供）→ 落库两径（优先：标引词重合匹配既有
 *   文档挂接；兜底：剪藏径落 sys-hub「雷达材料/」新文档并重索引）→ 返回出题任务书。
 * 不管什么：不出题（generate_questions 三闸门在 knomi-agent/出题官链路）、不判分、
 *   不做全站爬取；材料全文按剪藏同权责入用户私有库（frontmatter 带来源，可审计可删）。
 * 被谁调用：agent 工具 radar_collect_materials（出题前置采集）；题库侧边栏「题源雷达」页；
 *   互调契约：无跨插件依赖（选题自持、健康度自算——跨包禁互依）。
 * 质量闸（v2 评审）：材料支撑闸同 quiz-maker（KP 标题不命中材料=无支撑跳过）；
 *   D5——盲答验证能力缺失时材料照常入库但出题跳过；差评自动停采（差评率 ≥30% 或
 *   有效差评 ≥5），radarResume 手动恢复。
 */

const PLUGIN_ID = 'question-radar'
const GENERATOR = '题源雷达'

/** 模块级上下文：页数据/方法经 plugin:invoke 直调，运行于 activate 作用域外 */
let moduleCtx = null

const COOLDOWN_MS = 7 * 86400000
const MATERIAL_MAX_CHARS = 60000
const SNIPPET_MAX_CHARS = 300

// 源清单 v2（批次 S 域源矩阵）：内置 + 配置 radar_extra_sources（JSON 数组字符串，兼容保留；
// 可视化管理在批次 V-T-S09）。三道闸：结构/词表校验 → licenseStatus=verified → 通道完整。
const BUILTIN_SOURCES = require('./sources')
/** S06 校验器：domains ⊆ 词表快照（seed L1，漂移由 tests/question-radar-sources.test.js 对照 seed 锁定）；
 *  通道二选一：repo+branch+via:jsdelivr 或 site+via:site。返回 null=合格，字符串=拒绝原因 */
function validateSourceEntry(e) {
  if (!e || !e.id || !e.title) return '缺 id/title'
  if (!Array.isArray(e.domains) || e.domains.length === 0) return '缺 domains'
  for (const d of e.domains) {
    if (!BUILTIN_SOURCES.KNOWN_DOMAINS.includes(d)) return `域「${d}」不在词表（taxonomy-seed L1 快照）`
  }
  const hasRepo = e.repo && e.branch && e.via === 'jsdelivr'
  const hasSite = e.site && e.via === 'site'
  if (!hasRepo && !hasSite) return '缺有效通道（repo+branch+via:jsdelivr 或 site+via:site）'
  return null
}
function loadSources(cfg) {
  let extra = []
  try { extra = JSON.parse(String(cfg.extraSources || '[]')) } catch { extra = [] }
  const all = [...(BUILTIN_SOURCES.sources || []), ...(Array.isArray(extra) ? extra : [])]
  return all.filter((e) => {
    if (!e) return false
    if (validateSourceEntry(e)) return false                    // 结构/词表不合格
    if (e.licenseStatus !== 'verified') return false            // license 未核验不采集（SOP 第 5 步）
    return true
  })
}

/** KP 宿主文档的领域（taxonomy_semantics 权威；缺标引返回 null） */
async function kpDomain(kp) {
  if (!kp.documentId) return null
  try {
    const rows = (await moduleCtx.query(
      "SELECT COALESCE(NULLIF(ts.domain, ''), NULL) AS domain FROM documents d LEFT JOIN taxonomy_semantics ts ON ts.doc_id = d.id WHERE d.id = ?",
      [kp.documentId]
    )) || []
    return (rows[0] && rows[0].domain) || null
  } catch { return null }
}

/** 深度域判定（雷达本地轻量启发式 v1）：文档数最大域占比 ≥40% → 深度域。
 *  TODO:REFACTOR——宿主 learner-profile.ts 为完整打分实现，dashboard 卡片落地时雷达改经 ctx 消费收敛 */
async function detectDepthDomain() {
  try {
    const rows = (await moduleCtx.query(
      `SELECT COALESCE(NULLIF(ts.domain, ''), '未分类') AS domain, COUNT(*) AS docCount
       FROM documents d LEFT JOIN taxonomy_semantics ts ON ts.doc_id = d.id
       GROUP BY domain ORDER BY docCount DESC`
    )) || []
    const total = rows.reduce((n, r) => n + (Number(r.docCount) || 0), 0)
    if (total === 0 || rows.length === 0) return null
    const top = rows[0]
    return (Number(top.docCount) || 0) / total >= 0.4 ? top.domain : null
  } catch { return null }
}

/** 源清单直取（repos 通道）：KP 标题命中清单 topics → jsDelivr 列目录 → 主题词过滤 md → 读命中文件。
 *  frontmatter 携 source_repo/license（审计链）；失败返回 null（降级 sites/搜索通道）。 */
async function materialFromRegistry(kp, cfg, depthDomain) {
  const sources = loadSources(cfg).filter((e) => e.via === 'jsdelivr')
  if (sources.length === 0) return null
  const nTitle = normText(kp.title)
  const kpDom = await kpDomain(kp) // 注意：局部名不可与函数同名（TDZ 会被降级 catch 吞掉）
  const matched = sources.filter((e) => {
    const domainOk = !e.domains || !e.domains.length || (kpDom && e.domains.includes(kpDom)) || (depthDomain && e.domains.includes(depthDomain))
    const topicHit = (e.topics || []).some((t) => {
      const n = normText(t)
      return n.length >= 2 && (nTitle.includes(n) || n.includes(nTitle))
    })
    return domainOk && topicHit
  })
  for (const entry of matched.slice(0, 2)) {
    try {
      const listUrl = `https://data.jsdelivr.com/v1/packages/gh/${entry.repo}@${entry.branch}`
      const listRaw = await moduleCtx.web.read(listUrl)
      const list = JSON.parse(String(listRaw.content || '{}'))
      const files = (list.files || []).filter((f) => f.type === 'file' && /\.(md|markdown)$/i.test(f.name || ''))
      const nTitleTerms = extractTerms(kp.title).map(normText).filter((t) => t.length >= 2)
      const hitFiles = files
        .filter((f) => (entry.topics || []).some((t) => normText(f.name).includes(normText(t))) || nTitleTerms.some((t) => normText(f.name).includes(t)))
        .slice(0, 3)
      for (const f of hitFiles) {
        const cdnUrl = `https://cdn.jsdelivr.net/gh/${entry.repo}@${entry.branch}/${f.name}`
        if (!passesAllowlist(cdnUrl, cfg.allowlist)) continue
        const rd = await moduleCtx.web.read(cdnUrl)
        const text = String(rd.content || '')
        if (text.length >= 200) {
          return { url: cdnUrl, text, source: { repo: entry.repo, license: entry.license, path: f.name, title: entry.title } }
        }
      }
    } catch { /* 单源失败降级下一源 */ }
  }
  return null
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

/** sites 通道（S07 白名单权威站点试点）：KP 标题限站搜索 → read 正文 → 标准材料管线。
 *  frontmatter 携 source_site/license；失败返回 null（降级通用搜索）。礼仪面=白名单+同域限速（内核已有） */
async function materialFromSite(kp, cfg, depthDomain) {
  const sites = loadSources(cfg).filter((e) => e.via === 'site')
  if (sites.length === 0) return null
  for (const entry of sites.slice(0, 3)) {
    const domainOk = !entry.domains || !entry.domains.length || (depthDomain && entry.domains.includes(depthDomain))
    if (!domainOk) continue
    try {
      const results = await moduleCtx.web.search(`${kp.title} site:${entry.site}`, { count: 5 })
      const allowed = (results || []).filter((r) => passesAllowlist(r.url, cfg.allowlist))
      for (const r of allowed.slice(0, 2)) {
        try {
          const rd = await moduleCtx.web.read(r.url)
          const text = String(rd.content || '')
          if (text.length >= 200) {
            return { url: r.url, text, source: { site: entry.site, license: entry.license, title: entry.title } }
          }
        } catch { /* 单条读取失败降级下一条 */ }
      }
    } catch { /* 单站搜索失败降级下一站 */ }
  }
  return null
}

function sanitizeFileName(name) {
  return String(name || 'material')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'material'
}

/** 简易术语提取（材料↔文档标引词比对用；CJK 连续段 + 英文词） */
function extractTerms(text) {
  const terms = new Set()
  for (const m of String(text).matchAll(/[\u4e00-\u9fff]{2,8}/g)) terms.add(m[0])
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9_-]{2,20}/g)) terms.add(m[0].toLowerCase())
  return [...terms]
}

/** 读取插件配置（缺省兜底；configSchema 定义见 manifest） */
async function readConfig() {
  let cfg = {}
  try { cfg = (await moduleCtx.getConfig()) || {} } catch { cfg = {} }
  const budget = Math.min(Math.max(Number(cfg.radar_daily_kp_budget) || 5, 1), 20)
  const allowlist = String(cfg.radar_domains_allowlist || '')
    .split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  return { enabled: Boolean(cfg.radar_enabled), budget, allowlist, extraSources: String(cfg.radar_extra_sources || '') }
}

/** 生成器健康度（自算，避免跨插件依赖）：按 generator 分组的 题数/有效差评/反馈率/验证占比 */
async function healthByGenerator() {
  const rows = (await moduleCtx.query(
    `SELECT COALESCE(NULLIF(q.generator, ''), '未署名') AS generator,
            COUNT(DISTINCT q.id) AS total,
            SUM(CASE WHEN q.status != 'retired' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN q.verified = 1 THEN 1 ELSE 0 END) AS verified
     FROM questions q GROUP BY COALESCE(NULLIF(q.generator, ''), '未署名')`
  )) || []
  const fb = (await moduleCtx.query(
    `SELECT COALESCE(NULLIF(q.generator, ''), '未署名') AS generator, f.kind, COUNT(*) AS n
     FROM question_feedback f LEFT JOIN questions q ON q.id = f.question_id
     GROUP BY COALESCE(NULLIF(q.generator, ''), '未署名'), f.kind`
  )) || []
  const fbByGen = new Map()
  for (const r of fb) {
    const g = fbByGen.get(r.generator) || { bad: 0, good: 0, wrong: 0 }
    if (r.kind === 'bad_question') g.bad += Number(r.n) || 0
    if (r.kind === 'good_question') g.good += Number(r.n) || 0
    if (r.kind === 'wrong_answer') g.wrong += Number(r.n) || 0
    fbByGen.set(r.generator, g)
  }
  return rows.map((r) => {
    const g = fbByGen.get(r.generator) || { bad: 0, good: 0, wrong: 0 }
    const feedbackTotal = g.bad + g.good + g.wrong
    const effectiveBad = g.bad - g.good
    return {
      generator: r.generator,
      total: Number(r.total) || 0,
      active: Number(r.active) || 0,
      verified: Number(r.verified) || 0,
      bad: g.bad, good: g.good, wrong: g.wrong,
      feedbackRate: feedbackTotal > 0 ? Math.round((100 * (g.bad + g.wrong)) / feedbackTotal) : null,
      effectiveBad,
    }
  })
}

/** 雷达自身的停采判定（有效差评率 ≥30% 且样本 ≥3，或有效差评 ≥5）。
 *  P0 修正：rateHit 分子用「未被好评抵消的差评」——否则 radarResume 承诺的
 *  「好题抵消差评→自动恢复」在数学上救不回 rateHit（展示面 feedbackRate 口径不变） */
async function stopGateState() {
  const mine = (await healthByGenerator()).find((g) => g.generator === GENERATOR)
  const rate = mine && mine.feedbackRate != null ? mine.feedbackRate : null
  const sample = mine ? mine.bad + mine.good + mine.wrong : 0
  const effectiveRate = sample > 0 ? (Math.max(0, mine.bad - mine.good) + mine.wrong) / sample : null
  const rateHit = effectiveRate != null && effectiveRate * 100 >= 30 && sample >= 3
  const badHit = mine ? mine.effectiveBad >= 5 : false
  return { stopped: rateHit || badHit, rate, effectiveBad: mine ? mine.effectiveBad : 0, total: mine ? mine.total : 0 }
}

/** 优先径：材料 ↔ 库内文档匹配（taxonomy_semantics 标引词重合 + 文档标题包含）。
 *  返回 { documentId, documentTitle, score } 或 null（走剪藏兜底径）。 */
async function matchLibraryDoc(materialText, docTitle) {
  let kwRows = []
  try {
    kwRows = (await moduleCtx.query('SELECT doc_id, keywords_json FROM taxonomy_semantics')) || []
  } catch { kwRows = [] }
  let docs = []
  try { docs = (await moduleCtx.getDocuments()) || [] } catch { docs = [] }
  const docById = new Map(docs.map((d) => [d.id, d]))
  const nTitle = normText(docTitle)

  // 文档标引词集合
  const docKw = new Map() // docId -> Set(normalized keyword terms)
  for (const row of kwRows) {
    if (!row.doc_id) continue
    let kw = null
    try { kw = JSON.parse(String(row.keywords_json || '{}')) } catch { kw = null }
    if (!kw) continue
    const set = new Set()
    for (const t of [kw.domain, kw.topic, kw.tech, ...(Array.isArray(kw.tags) ? kw.tags : [])]) {
      const n = normText(t)
      if (n.length >= 2) set.add(n)
    }
    if (set.size > 0) docKw.set(row.doc_id, set)
  }

  const materialTerms = new Set(extractTerms(materialText).map(normText).filter((t) => t.length >= 2))
  let best = null
  for (const [docId, kws] of docKw) {
    let score = 0
    for (const t of kws) {
      if (materialTerms.has(t) || normText(materialText).includes(t)) score++
    }
    // S04 收紧：标题包含降为弱信号（+1）——需 ≥1 标引词重合才能过阈值，防零重合误挂接
    const doc = docById.get(docId)
    if (doc && nTitle && normText(doc.title).includes(nTitle)) score += 1
    if (score >= 2 && (!best || score > best.score)) {
      best = { documentId: docId, documentTitle: doc ? doc.title : '', score }
    }
  }
  return best
}

/** S04 材料 URL 去重：同源 URL 已入库（radar-material frontmatter 溯源）→ 复用该文档，不重复剪藏 */
async function findExistingMaterialDoc(url) {
  const u = String(url || '')
  if (!u || u.length < 10) return null
  try {
    const rows = (await moduleCtx.query(
      // url 作 LIKE 子串直配（个人库规模，无 %/_ 转义必要；命中面=frontmatter 溯源链）
      "SELECT d.id, d.title FROM documents d WHERE d.frontmatter LIKE ? LIMIT 1",
      [`%${u}%`]
    )) || []
    return rows[0] ? { documentId: rows[0].id, documentTitle: rows[0].title } : null
  } catch { return null }
}

/** 兜底径（剪藏）：材料落 sys-hub「雷达材料/」新文档（frontmatter 带来源，可审计可删）并重索引。
 *  返回 { documentId, documentTitle, filePath } 或 { error }（sys-hub 缺失/索引未见）。 */
async function clipMaterial(kpTitle, material) {
  let repos = []
  try { repos = (await moduleCtx.listRepositories()) || [] } catch { repos = [] }
  const hub = repos.find((r) => r && r.name === 'sys-hub' && r.localPath) || repos.find((r) => r && r.localPath)
  if (!hub || !hub.localPath) return { error: 'sys-hub 仓库不可用，剪藏径无法落盘' }
  const dir = `${hub.localPath.replace(/[\\/]+$/, '')}/雷达材料`
  const filePath = `${dir}/${sanitizeFileName(kpTitle)}-${new Date().toISOString().slice(0, 10)}.md`

  const lines = []
  lines.push('---')
  lines.push('knomi:')
  lines.push('  type: radar-material')
  lines.push('  schemaVersion: 1')
  lines.push('  provenance:')
  lines.push(`    generated_by: ${PLUGIN_ID}`)
  lines.push(`    source_url: ${JSON.stringify(material.url || '')}`)
  if (material.source) {
    if (material.source.repo) lines.push(`    source_repo: ${JSON.stringify(material.source.repo)}`)
    if (material.source.site) lines.push(`    source_site: ${JSON.stringify(material.source.site)}`)
    lines.push(`    source_license: ${JSON.stringify(material.source.license || '未核对')}`)
    if (material.source.path) lines.push(`    source_path: ${JSON.stringify(material.source.path)}`)
  }
  lines.push(`    collected_at: ${JSON.stringify(new Date().toISOString())}`)
  lines.push(`    kp_title: ${JSON.stringify(kpTitle)}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${kpTitle}`)
  lines.push('')
  lines.push(`> 来源：${material.url || '探针/代理注入'}（题源雷达采集）`)
  lines.push('')
  lines.push(String(material.text || '').slice(0, MATERIAL_MAX_CHARS))
  lines.push('')

  await moduleCtx.writeFile(filePath, lines.join('\n'))
  await moduleCtx.reindexRepository(hub.id)
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const doc = ((await moduleCtx.getDocuments(hub.id)) || []).find((d) => norm(d.filePath) === norm(filePath))
  if (!doc) return { error: `剪藏已写入 ${filePath}，但重索引后未检索到文档` }
  return { documentId: doc.id, documentTitle: doc.title || kpTitle, filePath }
}

/** 域名白名单过滤（configSchema radar_domains_allowlist；空 = 不限制） */
function passesAllowlist(url, allowlist) {
  if (!allowlist || allowlist.length === 0) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    return allowlist.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

/**
 * 采集主流程（agent 工具 radar_collect_materials 与页面动作共同入口）。
 * args: { dryRun?: boolean, limit?: number, materials?: [{ kpId, kpTitle, url, text }] }
 * materials 注入通道：探针 fixture / agent 直供材料（搜索不可达时的替代采集路径）。
 * 返回 { coverage, tasks, skipped }——tasks 即出题任务书（documentId 必备，接地对象=该文档）。
 */
async function radarCollect(args = {}) {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  const cfg = await readConfig()
  const dryRun = Boolean(args.dryRun)
  if (!cfg.enabled && !dryRun) {
    return { error: '雷达采集未启用：请在插件管理 → 题源雷达 配置中开启「启用雷达采集」（采集行为需显式同意）' }
  }

  // 清偿保险丝（批次 D-5）：到期积压超过近 7 天日均作答 ×2 → 先清偿再采集；
  // dryRun 豁免（只读观察），统计失败旁路（向后兼容）
  try {
    const rhythm = await moduleCtx.studyRhythm()
    const fuse = rhythm && rhythm.backlogFuse
    if (fuse && fuse.tripped && !dryRun) {
      return { error: `复习债超限：到期 ${fuse.dueCount} 题 > 清偿能力（日均 ${fuse.dailyAvg} 题 × 2）——请先完成「今日复习」清偿积压，再采集新材料` }
    }
  } catch { /* 节奏通道不可用不阻塞 */ }

  // 停采闸（非 dryRun 强制；dryRun 只读也放行——供验收观察停采状态本身）
  const gate = await stopGateState()
  let stopInfo = null
  if (gate.stopped && !dryRun) {
    return {
      error: `题源雷达已自动停采（差评率 ${gate.rate == null ? '—' : gate.rate + '%'}，有效差评 ${gate.effectiveBad}）——请先在题库页复盘/清理差评题，再点「恢复采集」`,
    }
  }
  if (gate.stopped) stopInfo = `已停采（差评率 ${gate.rate == null ? '—' : gate.rate + '%'}，有效差评 ${gate.effectiveBad}）`

  // 选题：未覆盖 → 薄弱，7 天冷却，日预算
  const limit = Math.min(Math.max(Number(args.limit) || cfg.budget, 1), cfg.budget)
  const today = new Date().toISOString().slice(0, 10)
  let usedToday = Number(await moduleCtx.storage.get('budget', `day:${today}`)) || 0
  const remainingBudget = Math.max(0, cfg.budget - usedToday)
  const injected = Array.isArray(args.materials) ? args.materials : []
  const byKpId = new Map(injected.map((m) => [String(m.kpId || ''), m]))

  const uncovered = (await moduleCtx.query(
    `SELECT kp.id, kp.title, kp.document_id AS documentId
     FROM knowledge_points kp
     LEFT JOIN questions q ON q.knowledge_point_id = kp.id
     WHERE q.id IS NULL
     ORDER BY kp.created_at LIMIT 60`
  )) || []
  const weak = (await moduleCtx.query(
    `SELECT DISTINCT kp.id, kp.title, kp.document_id AS documentId
     FROM knowledge_points kp
     JOIN questions q ON q.knowledge_point_id = kp.id
     LEFT JOIN question_attempts a ON a.question_id = q.id
     WHERE q.status != 'retired'
     GROUP BY kp.id
     HAVING COUNT(a.id) >= 2 AND SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) * 100 < COUNT(a.id) * 60
     ORDER BY kp.created_at LIMIT 60`
  )) || []
  const candidates = [
    ...uncovered.map((kp) => ({ ...kp, reason: 'uncovered' })),
    ...weak.map((kp) => ({ ...kp, reason: 'weak' })),
  ]

  const tasks = []
  const skipped = []
  let selected = 0
  const depthDomain = await detectDepthDomain()
  // D5（P0 语义修正）：仅「验证通道缺失」（宿主未提供 verifyQuestions）才跳过出题；
  // Provider 未配置由宿主 verifyQuestions 内部降级（题目 unverified 入库），出题照常
  const verifyChannelAvailable = typeof moduleCtx.verifyQuestions === 'function'
  const breadthAllowance = Math.max(1, Math.floor(cfg.budget * 0.3)) // D-4：广度带 ≤30% 预算
  let breadthUsed = Number((await moduleCtx.storage.get('budget', `breadth:${today}`)) || 0)
  for (const kp of candidates) {
    if (selected >= Math.min(limit, remainingBudget)) break
    let lastAt = ''
    try { lastAt = String((await moduleCtx.storage.get('radar', 'kp:' + kp.id)) || '') } catch { lastAt = '' }
    if (lastAt && Date.now() - new Date(lastAt).getTime() < COOLDOWN_MS) {
      skipped.push({ kpTitle: kp.title, reason: '7 天冷却中' })
      continue
    }
    // 域感知预算（D-4）：广度带 KP 受 30% 子预算约束（深度域不限）
    const kpDom = await kpDomain(kp)
    const isBreadth = Boolean(depthDomain && kpDom && kpDom !== depthDomain)
    if (isBreadth && breadthUsed >= breadthAllowance) {
      skipped.push({ kpTitle: kp.title, reason: `广度带预算已用（${breadthUsed}/${breadthAllowance}）——优先深度域「${depthDomain}」` })
      continue
    }

    // 材料获取四级降级：注入通道优先（探针/agent 直供）→ 源清单 repos 直取（D-3）→ sites 站点（S07）→ 搜索引擎
    let material = null
    const inj = byKpId.get(kp.id) || (injected.length === 1 ? injected[0] : null)
    if (inj && inj.text) {
      material = { url: String(inj.url || ''), text: String(inj.text) }
    } else {
      try {
        material = await materialFromRegistry(kp, cfg, depthDomain)
      } catch { /* repos 通道失败降级 sites */ }
      if (!material) {
        try {
          material = await materialFromSite(kp, cfg, depthDomain)
        } catch { /* sites 通道失败降级搜索 */ }
      }
      if (!material) {
        try {
          const results = await moduleCtx.web.search(kp.title, { count: 5 })
          const allowed = results.filter((r) => passesAllowlist(r.url, cfg.allowlist))
          for (const r of allowed.slice(0, 3)) {
            try {
              const rd = await moduleCtx.web.read(r.url)
              if (String(rd.content || '').length >= 200) {
                material = { url: r.url, text: rd.content }
                break
              }
            } catch { /* 单条读取失败降级下一条 */ }
          }
        } catch { /* 搜索失败降级跳过 */ }
      }
    }
    if (!material || String(material.text || '').trim().length < 100) {
      skipped.push({ kpTitle: kp.title, reason: '未采集到合格材料（搜索失败/正文过短）' })
      continue
    }

    // 材料支撑闸（H2 教训闸的雷达变体）：KP 标题需在材料中可考
    if (!normText(material.text).includes(normText(kp.title).slice(0, 4))) {
      // 标题长于 4 字时取前 4 字宽松命中（章节名常见前缀差异）
      const strict = normText(material.text).includes(normText(kp.title))
      if (!strict) {
        skipped.push({ kpTitle: kp.title, reason: 'KP 标题未命中材料（无材料支撑）' })
        continue
      }
    }

    // 落库两径 + S04 去重：优先标引匹配 → 同源 URL 已入库则复用该文档（不重复剪藏）→ 剪藏兜底
    const match = await matchLibraryDoc(material.text, kp.title)
    let task
    if (match) {
      task = {
        kpId: kp.id, kpTitle: kp.title, reason: kp.reason,
        match: 'library', documentId: match.documentId, documentTitle: match.documentTitle, score: match.score,
        materialUrl: material.url,
      }
    } else {
      const existing = await findExistingMaterialDoc(material.url)
      if (existing) {
        task = {
          kpId: kp.id, kpTitle: kp.title, reason: kp.reason,
          match: 'library', documentId: existing.documentId, documentTitle: existing.documentTitle,
          deduped: true, materialUrl: material.url,
        }
      } else if (dryRun) {
        task = {
          kpId: kp.id, kpTitle: kp.title, reason: kp.reason,
          match: 'would-clip', documentId: null, documentTitle: null,
          materialUrl: material.url, materialPreview: String(material.text).slice(0, 120),
        }
      } else {
        const clipped = await clipMaterial(kp.title, material)
        if (clipped.error) {
          skipped.push({ kpTitle: kp.title, reason: `剪藏落库失败：${clipped.error}` })
          continue
        }
        task = {
          kpId: kp.id, kpTitle: kp.title, reason: kp.reason,
          match: 'clip', documentId: clipped.documentId, documentTitle: clipped.documentTitle,
          materialUrl: material.url,
        }
      }
    }

    // D5：验证通道缺失 → 材料照常入库（上文已完成），出题跳过；
    // 署名链（P0）：任务书强制携带 generator——停采闸与健康度分组按 generator=题源雷达 统计
    task.generate = verifyChannelAvailable
    if (!verifyChannelAvailable) task.skipReason = '盲答验证通道缺失（D5 宁停不污染题库）'
    task.generator = GENERATOR
    if (isBreadth) breadthUsed++
    tasks.push(task)
    selected++
  }

  // 冷却 + 日预算记账（dryRun 不记账；无论出题是否发生——采集即消耗）
  if (!dryRun) {
    const now = new Date().toISOString()
    for (const t of tasks) {
      try { await moduleCtx.storage.set('radar', 'kp:' + t.kpId, now) } catch { /* 忽略 */ }
    }
    try { await moduleCtx.storage.set('budget', `day:${today}`, String(usedToday + tasks.length)) } catch { /* 忽略 */ }
    try { await moduleCtx.storage.set('budget', `breadth:${today}`, String(breadthUsed)) } catch { /* 忽略 */ }
    usedToday += tasks.length
  }

  return {
    coverage: {
      uncoveredTotal: uncovered.length,
      weakTotal: weak.length,
      selected: tasks.length,
      skipped: skipped.length,
      budgetUsedToday: dryRun ? undefined : usedToday,
      budgetDaily: cfg.budget,
    },
    stopInfo,
    verifyAvailable: verifyChannelAvailable,
    tasks,
    skipped: skipped.slice(0, 10),
  }
}

/** 题源雷达侧边栏页（nav.entry）：停采/预算状态 + 按 generator 分组的题库健康度 + 采集入口 */
async function pageRadar() {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  const cfg = await readConfig()
  const gate = await stopGateState()
  const today = new Date().toISOString().slice(0, 10)
  let usedToday = 0
  try { usedToday = Number((await moduleCtx.storage.get('budget', `day:${today}`)) || 0) } catch { usedToday = 0 }
  const groups = await healthByGenerator().catch(() => [])
  const depthDomain = await detectDepthDomain()
  let fuse = null
  try { fuse = ((await moduleCtx.studyRhythm()) || {}).backlogFuse || null } catch { fuse = null }

  const summaryParts = []
  summaryParts.push(cfg.enabled ? '采集已启用' : '采集未启用（配置中开启）')
  summaryParts.push(`深度域：${depthDomain || '未判定（域分布均衡）'}`)
  summaryParts.push(`今日采集 ${usedToday}/${cfg.budget} 个知识点`)
  if (fuse) summaryParts.push(fuse.tripped ? `⛔ 复习债超限（到期 ${fuse.dueCount} > 清偿能力 ${fuse.threshold}）——采集暂停` : `复习债正常（到期 ${fuse.dueCount}/${fuse.threshold}）`)
  if (gate.stopped) summaryParts.push(`⛔ 已自动停采（差评率 ${gate.rate == null ? '—' : gate.rate + '%'}，有效差评 ${gate.effectiveBad}）`)

  return {
    title: `题源雷达 · ${gate.stopped ? '已停采' : (cfg.enabled ? '运行中' : '未启用')}`,
    summary: summaryParts.join(' · '),
    stats: [
      { label: '深度域', value: depthDomain || '—' },
      { label: '今日采集', value: `${usedToday}/${cfg.budget}` },
      { label: '到期积压', value: fuse ? `${fuse.dueCount} 题` : '—' },
      { label: '采集状态', value: gate.stopped ? '⛔停采' : (cfg.enabled ? '运行中' : '未启用') },
    ],
    columns: [
      { key: 'generator', label: '出题来源' },
      { key: 'total', label: '题数', width: 70 },
      { key: 'active', label: '在库', width: 70 },
      { key: 'verified', label: '已验证', width: 80 },
      { key: 'feedbackRate', label: '差评率', width: 80 },
      { key: 'effectiveBad', label: '有效差评', width: 90 },
    ],
    rows: groups.map((g) => ({
      id: g.generator,
      generator: g.generator,
      total: g.total,
      active: g.active,
      verified: g.verified,
      feedbackRate: g.feedbackRate == null ? '—' : `${g.feedbackRate}%`,
      effectiveBad: g.effectiveBad,
    })),
    action: gate.stopped
      ? { label: '恢复采集', method: 'radarResume' }
      : { label: '开始采集（交小诺出题）', method: 'pageRadarHandoff' },
    secondaryActions: cfg.enabled
      ? [{ label: '暂停采集（关闭开关）', method: 'pageDisableRadar' }]
      : [{ label: '启用采集（开启开关）', method: 'pageEnableRadar' }],
  }
}

/** 页级动作：交给小诺采集+出题（agent_handoff 到达即开工，FR-124 模式） */
async function pageRadarHandoff() {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  return {
    message: '已交给小诺采集（新会话将自动发送指令）',
    ui: {
      intent: 'agent_handoff',
      message: '请调用 radar_collect_materials 采集一批网络材料（题源雷达），按返回的任务书逐知识点委派「出题官」出题，最后用 generate_questions 入库（每题必带任务书给出的 documentId 与 knowledgePointTitle，generator 必须传「题源雷达」——署名驱动差评停采闸与健康度分组，sourceSnippet 逐字摘自材料文档；任务书标注「跳过出题」的知识点不要出题）。',
    },
  }
}

/** 页级开关（secondaryActions）：显式置位而非读-翻-写（防连点翻转/状态漂移，P0 探针实证） */
async function setRadarEnabled(target) {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  const cfg = await readConfig()
  if (cfg.enabled === target) return { message: `雷达采集已是${target ? '启用' : '关闭'}状态（无变化）` }
  await moduleCtx.setConfig({ radar_enabled: target })
  return { message: `雷达采集已${target ? '启用' : '关闭'}${target ? '（网络采集与材料入库将按预算执行）' : ''}` }
}
const pageEnableRadar = () => setRadarEnabled(true)
const pageDisableRadar = () => setRadarEnabled(false)

/** 停采后的手动恢复（页级动作） */
async function radarResume() {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  const gate = await stopGateState()
  if (!gate.stopped) return { message: '当前未处于停采状态。' }
  return { message: '停采状态由差评数据驱动（非开关）：请先在题库页复盘/恢复差评题（好题抵消差评），差评率回落到阈值下后自动恢复采集。当前有效差评 ' + gate.effectiveBad + '。' }
}

/** 探针/测试收尾通道（quiz-maker clearExpansionCooldown 同款先例）：清冷却与当日预算记账。
 *  生产正常流不调用——清空后当日预算与 7 天冷却从零计。 */
async function radarResetProbeState() {
  if (!moduleCtx) return { error: '题源雷达未激活' }
  let cleared = 0
  for (const ns of ['radar', 'budget']) {
    try {
      // 宿主 storage.list 返回 [{key,value,updatedAt}]（2026-09-26 真机实证）；兼容字符串键形态
      const items = (await moduleCtx.storage.list(ns)) || []
      for (const item of items) {
        const key = item && typeof item === 'object' ? item.key : item
        if (key == null) continue
        try { await moduleCtx.storage.delete(ns, key); cleared++ } catch { /* 单键失败忽略 */ }
      }
    } catch { /* 命名空间不可读忽略 */ }
  }
  return { message: `已清除 ${cleared} 条冷却/预算记账（探针收尾）`, cleared }
}

module.exports = {
  id: PLUGIN_ID,
  name: '题源雷达',
  version: '0.4.0',
  description: '关键词驱动的网络材料采集：两径落库 + 出题任务书 + 差评自动停采',

  activate(context) {
    moduleCtx = context
    // agent 工具：出题前置采集（agent 调用后按任务书委派出题官 → generate_questions）
    context.registerAgentTool(
      {
        name: 'radar_collect_materials',
        description: '题源雷达采集：为「0 覆盖/薄弱」知识点从网络搜集材料并落库（匹配既有文档优先，未命中剪藏入库），返回逐知识点出题任务书。收到任务书后：仅对 generate=true 的知识点委派「出题官」出题并调用 generate_questions（documentId/knowledgePointTitle/generator=「题源雷达」按任务书传，sourceSnippet 逐字摘自该文档）；generate=false（盲答验证通道缺失）的知识点跳过出题。用户说「采集新材料/雷达采集/为薄弱知识点找材料」时使用。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '本次采集知识点数上限（默认与每日预算一致）' },
            materials: {
              type: 'array',
              description: '可选：直供材料（[{kpId,kpTitle,url,text}]），跳过网络搜索；仅当用户明确提供材料内容时使用',
              items: { type: 'object', properties: { kpId: { type: 'string' }, kpTitle: { type: 'string' }, url: { type: 'string' }, text: { type: 'string' } } },
            },
          }
        }
      },
      async (args) => {
        const r = await radarCollect({ limit: args && args.limit, materials: args && args.materials })
        if (r.error) return { output: '', error: r.error }
        const c = r.coverage || {}
        const lines = [`题源雷达采集完成：本次 ${r.tasks.length} 个知识点（未覆盖 ${c.uncoveredTotal}/薄弱 ${c.weakTotal}，日预算已用 ${c.budgetUsedToday}/${c.budgetDaily}）。`]
        if (r.stopInfo) lines.push(`⛔ ${r.stopInfo}`)
        r.tasks.forEach((t, i) => {
          lines.push('')
          lines.push(`## 材料任务书 ${i + 1}：${t.kpTitle}（${t.reason === 'uncovered' ? '0 题覆盖' : '薄弱'}；落库路径：${t.match === 'library' ? `匹配既有文档《${t.documentTitle}》` : '剪藏入库新文档《' + t.documentTitle + '》'}）`)
          lines.push(`documentId=${t.documentId}（knowledgePointTitle 必须传「${t.kpTitle}」，generator 必须传「题源雷达」）`)
          lines.push(`材料来源：${t.materialUrl || '注入'}`)
          if (!t.generate) lines.push('⛔ 盲答验证能力不可用：该知识点本轮跳过出题（材料已入库沉淀）。')
        })
        if (r.skipped.length > 0) {
          lines.push('')
          lines.push(`已跳过：${r.skipped.map((x) => `「${x.kpTitle}」${x.reason}`).join('；')}。`)
        }
        if (!r.verifyAvailable) {
          lines.push('')
          lines.push('⛔ 盲答验证通道不可用（宿主未提供 verifyQuestions）——本轮所有材料仅入库沉淀，全部跳过出题（宁停不污染题库）。')
        } else {
          lines.push('')
          lines.push('ℹ️ 未配置可用 AI Provider 时盲答验证会自动降级：题目以「未验证」状态入库，可在题库页复盘。')
        }
        lines.push('')
        lines.push('执行方式：仅对 generate=true 的知识点，委派「出题官」（launch_subagent, preset=出题官）或按材料文档直接出题；generate_questions 时 generator 必须传「题源雷达」（署名驱动差评停采闸与健康度分组），documentId 与 knowledgePointTitle 按任务书原样传，sourceSnippet 逐字摘自该文档（接地校验按 documentId 读库比对）。')
        return { output: lines.join('\n'), result: { coverage: r.coverage, tasks: r.tasks } }
      }
    )
  },

  deactivate() {},

  pageRadar,
  pageRadarHandoff,
  pageEnableRadar,
  pageDisableRadar,
  radarResume,
  radarCollect,
  radarResetProbeState,
  validateSourceEntry,
  loadSources,
  healthByGenerator,
}
