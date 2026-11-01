// 精选的门槛。评分标准本身写在 prompts/selection-score.md；这里只决定“多少分算入选”。
// 每篇资料由评分模型独立打两次分（0–100），两次之和 ≥ 2 × 门槛才成为精选候选；
// 确认新闻身份与新增价值后，由发布规则决定展示（见 docs/selection.md），卡片上显示两次的平均分。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些；信源类别再把某些官方信源的门槛抬高。
// 注意：这组数沿用示例站的起步值，本行业尚未校准。先标注 100–200 条样本（.data/gold.jsonl，格式见
// docs/selection.md 与 industry/gold.example.jsonl），再跑
// node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl
// 看准确率和门槛扫描，最后才决定调不调（先改评分标准，再动门槛）。

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   */
  thresholds: { T1: 60, T1_5: 65, T2: 76 } as Record<string, number>,
  /**
   * 信源类别 → 门槛下限。分级只说明来源是不是官方、一手；有些官方信源的日常内容主要写给开发者或业内，
   * 读者要看的只是其中的大事，就在后台“信源”里给它一个类别，门槛抬到不低于这里的数。
   * 只抬不降：分级门槛本来就更高的（媒体）不受影响。没有类别的信源只按分级。
   *   devinfra 开发者生态与基础设施：GitHub、Hugging Face、NVIDIA、云与推理框架这类官方开发者渠道，
   *            日常大量生态与工具内容，读者要看的只是其中的大事
   *   leaderboard 评测榜单：给各家模型跑分、排名的评测机构
   * 类别未随本行业校准，首轮评测后可一并复核。
   */
  classes: {
    devinfra: { label: "开发者生态与基础设施", threshold: 70 },
    leaderboard: { label: "评测榜单", threshold: 76 },
  } as Record<string, { label: string; threshold: number }>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
  /**
   * 浏览“全部动态”（网页列表、接口和 RSS 的全部模式）只出平均分不低于这个数的资料，没评上分的照常出；
   * 搜索仍覆盖全部。低于 40 分的多是转述和资讯账号的刷屏（曾占全部动态三分之一以上），精选从没收过 60 分以下的。
   */
  browseFloor: 40,
} as const;
