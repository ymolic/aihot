// 读者看得到的文字里本站不用的词，每项是要找的写法和改法（例如 [/重磅|炸裂/u, "不用夸张的说法，直接写发生了什么"]）。
// 写作那一步写完中文标题、摘要和推荐理由后逐个查，用了就让模型只改这些地方一次（packages/backend/src/editorial/
// analyze.ts 的 mendWording）。只列一眼就能判断的写法：拿不准的不列，否则会误改正常的词。空着就不查。
//
// 本行业包暂不启用改用词：夸张用语的约束已经写在写作提示词里（content-understanding.md 的禁用词表，
// 覆盖“重磅”“炸裂”“必读”一类），暂无本站特有的、一眼可判的坏词。等运营中真的出现反复出现的坏写法
// （比如某个信源的固定标题腔），再把那条词加进来，不要预填拿不准的词。

export const READER_WORDING: ReadonlyArray<readonly [RegExp, string]> = [];
