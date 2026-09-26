// ============================================================
// 题源雷达源清单 v2（生产化批次 S，2026-09-26；前序 v1 见 git 史）
// 结构：域源矩阵——每条目挂 domains（词表=single source of truth，见 KNOWN_DOMAINS）+
//       通道二选一：repos 仓（via:jsdelivr，{repo,branch}）或 sites 站（via:site，{site}）。
// license 纪律（生产化计划附录 B/A1，2026-09-26 GitHub API 核验）：
//   ①licenseStatus:'verified' 才可采集（loadSources 强制过滤；draft-unverified 为占位待核）；
//   ②无 license / ND 不入清单；NC 可入（本地个人使用，frontmatter 如实记录）；
//   ③核验值带 API 核验日期；换源/新增走计划附录 B SOP 六步。
// v1 移除项（API 实证无 license/停更）：CS-Notes、Daily-Interview-Question——不再收录。
// 词表纪律：KNOWN_DOMAINS 是 resources/taxonomy-seed.json L1 的快照，漂移由
//   tests/question-radar-sources.test.js 对照 seed 文件锁定（map.yaml 同款门禁模式）；
//   seed 升版时改这里必须连带过测试。软件测试类知识在种子词表下归属「计算机技术」域。
// ============================================================

const KNOWN_DOMAINS = [
  '计算机技术', '经济', '社会科学', '数理科学', '哲学与宗教', '文化科学教育', '艺术',
  '历史与地理', '医药卫生', '马克思主义理论', '政治法律', 'E 军事', '语言文字', 'I 文学',
  '自然科学', '天文地球', '生物科学', '农业科学', '交通运输', '航空航天', '环境安全', '综合',
]

module.exports = {
  version: 2,
  note: '题源雷达域源矩阵 v2（批次 S）。license 全部经 GitHub API/站点授权页核验（2026-09-26）。收录政策：无 license/ND 不入，NC 标注可入（本地个人使用）；repo>500MB 走 sites 通道。软件测试类知识按种子词表归属「计算机技术」域。',
  KNOWN_DOMAINS,

  sources: [
    // ---- repos 通道（jsDelivr 直取；全部 API 核验 2026-09-26）----
    {
      id: 'javaguide',
      title: 'JavaGuide（Java 后端面试与进阶）',
      domains: ['计算机技术'],
      license: 'Apache-2.0（GitHub API 核验 2026-09-26）',
      licenseStatus: 'verified',
      repo: 'Snailclimb/JavaGuide',
      branch: 'main',
      via: 'jsdelivr',
      topics: ['Java', '并发', 'JVM', '后端', '面试', 'Spring', '分布式', '数据库'],
    },
    {
      id: 'hello-algo',
      title: 'Hello 算法（动画图解的数据结构与算法）',
      domains: ['计算机技术'],
      license: 'CC BY-NC-SA 4.0（LICENSE 文件核验 2026-09-26；NC：本地个人使用）',
      licenseStatus: 'verified',
      repo: 'krahets/hello-algo',
      branch: 'main',
      via: 'jsdelivr',
      topics: ['算法', '数据结构', 'LeetCode', '动态规划', '排序', '复杂度'],
    },
    {
      id: 'advanced-java',
      title: 'advanced-java（Java 后端高并发/分布式/系统设计）',
      domains: ['计算机技术'],
      license: 'CC BY-SA 4.0（GitHub API 核验 2026-09-26）',
      licenseStatus: 'verified',
      repo: 'doocs/advanced-java',
      branch: 'main',
      via: 'jsdelivr',
      topics: ['分布式', '高并发', '微服务', '系统设计', '消息队列', '缓存', 'RPC'],
    },
    {
      id: 'self-llm',
      title: '开源大模型食用指南（微调/部署/多模态）',
      domains: ['计算机技术'],
      license: 'Apache-2.0（GitHub API 核验 2026-09-26）',
      licenseStatus: 'verified',
      repo: 'datawhalechina/self-llm',
      branch: 'master',
      via: 'jsdelivr',
      topics: ['大语言模型', 'LLM', '微调', 'LoRA', '部署', '多模态', '推理'],
    },
    {
      id: 'javascript-questions',
      title: 'JavaScript Questions（JS 进阶题解，英文）',
      domains: ['计算机技术'],
      license: 'MIT（GitHub API 核验 2026-09-26）',
      licenseStatus: 'verified',
      repo: 'lydiahallie/javascript-questions',
      branch: 'main',
      via: 'jsdelivr',
      topics: ['JavaScript', '前端', '闭包', '原型', '事件循环'],
    },
    {
      id: 'httprunner',
      title: 'HttpRunner（API/UI 测试框架，中文文档）',
      domains: ['计算机技术'],
      license: 'Apache-2.0（GitHub API 核验 2026-09-26）',
      licenseStatus: 'verified',
      repo: 'httprunner/httprunner',
      branch: 'master',
      via: 'jsdelivr',
      topics: ['软件测试', '接口测试', '自动化测试', 'API 测试', '测试用例', '性能测试'],
    },
    // ---- sites 通道（白名单权威站点试点，S07；限站搜索+read，礼仪对冲=白名单+同域限速）----
    {
      id: 'wikibooks-zh',
      title: '中文维基教科书（CC BY-SA 公开教材社区）',
      domains: ['经济', '社会科学', '文化科学教育', '综合'],
      license: 'CC BY-SA 4.0（站点级公开授权，核验 2026-09-26）',
      licenseStatus: 'verified',
      site: 'zh.wikibooks.org',
      via: 'site',
      topics: ['经济学', '管理学', '心理学', '社会学', '教育学', '宏观', '微观'],
    },
    {
      id: 'openstax',
      title: 'OpenStax Open Textbooks（英文公开教材）',
      domains: ['经济', '数理科学'],
      license: 'CC BY 4.0（站点级公开授权，核验 2026-09-26）',
      licenseStatus: 'verified',
      site: 'openstax.org',
      via: 'site',
      topics: ['经济学', '宏观经济', '微观经济', '统计学', '代数', '微积分'],
    },
    // ---- 占位待核（draft-unverified 采集器强制跳过——SOP 第 5 步语义保留）----
    {
      id: 'software-testing-theory',
      title: '软件测试理论/测试基础教材类（占位：GitHub 无 license 合格仓，待按 SOP 渐进补源）',
      domains: ['计算机技术'],
      license: '未核对',
      licenseStatus: 'draft-unverified',
      repo: '',
      branch: '',
      via: 'jsdelivr',
      topics: ['测试基础', '黑盒测试', '白盒测试'],
    },
  ],
}
