export const assistantMaterialsZh = {
  assistantSelectedOnly: '仅看已选',
  assistantNoSelectedFiles: '还没有选中的文件。',
  assistantDatasetLabel: '任务数据集',
  assistantDatasetCoverage: '{{sources}} 个来源 · {{readable}} / {{files}} 份文件可读',
  assistantDatasetCap: '已选 {{count}} 份 · 每次最多使用 {{max}} 份',
  assistantDatasetExcerptCount: '已选 {{count}} 段摘录',
  assistantDatasetChoose: '选择数据集文件',
  assistantDatasetChooseHint: '可读文件超过单次上限。请选出与这次任务相关的文件。',
  assistantDatasetEmpty: '此数据集当前没有可读文件。可在数据工作台检查来源。',
};

export const assistantMaterialsEn: Record<keyof typeof assistantMaterialsZh, string> = {
  assistantSelectedOnly: 'Selected only',
  assistantNoSelectedFiles: 'No files selected yet.',
  assistantDatasetLabel: 'Task dataset',
  assistantDatasetCoverage: '{{sources}} sources · {{readable}} of {{files}} files readable',
  assistantDatasetCap: '{{count}} selected · up to {{max}} per request',
  assistantDatasetExcerptCount: 'Selected excerpts {{count}}',
  assistantDatasetChoose: 'Choose dataset files',
  assistantDatasetChooseHint: 'There are more readable files than one request can use. Choose the files relevant to this task.',
  assistantDatasetEmpty: 'This dataset has no readable files. Check its sources in the data workbench.',
};
