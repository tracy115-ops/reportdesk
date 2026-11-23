import { DatabaseOutlined, DownOutlined, FileOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ReportProfile } from './domain';
import type { AssistantDatasetScope } from './office';
import './task-scope-picker.css';

export interface TaskScopePickerProps {
  profiles: readonly ReportProfile[];
  dataset?: Pick<AssistantDatasetScope, 'id' | 'name'>;
  filenames: readonly string[];
  count?: number;
  showAttachments?: boolean;
  disabled?: boolean;
  changing?: boolean;
  onSelect: (id?: string) => void;
  onManage: () => void;
}

const copy = {
  zh: {
    scope: '资料范围', general: '通用任务', datasets: '数据集', manage: '管理数据集', create: '创建数据集',
    selected: (count: number) => `已选 ${count} 份文件`, empty: '未附加文件', changing: '正在读取所选资料',
  },
  en: {
    scope: 'Source scope', general: 'General task', datasets: 'Datasets', manage: 'Manage datasets', create: 'Create dataset',
    selected: (count: number) => `${count} ${count === 1 ? 'file' : 'files'} selected`, empty: 'No files selected', changing: 'Reading selected sources',
  },
};

const defaultKey = 'general';
const manageKey = 'manage';
const datasetKey = (id: string) => 'dataset:' + id;

export default function TaskScopePicker({ profiles, dataset, filenames, count = filenames.length, showAttachments = true, disabled, changing,
  onSelect, onManage }: TaskScopePickerProps) {
  const { i18n } = useTranslation();
  const text = i18n.language.startsWith('zh') ? copy.zh : copy.en;
  const activeKey = dataset ? datasetKey(dataset.id) : defaultKey;
  const scopeName = dataset?.name ?? text.general;
  const items: MenuProps['items'] = [{ key: defaultKey, label: text.general, icon: <FolderOpenOutlined /> }];
  if (profiles.length) items.push({ type: 'group', label: text.datasets, children: profiles.map(profile => ({
    key: datasetKey(profile.id), label: <span className="task-scope-option" title={profile.name}>{profile.name}</span>, icon: <DatabaseOutlined />,
  })) });
  items.push({ type: 'divider' }, { key: manageKey, label: profiles.length ? text.manage : text.create, icon: <PlusOutlined /> });

  return <div className="task-scope-picker" data-has-dataset={!!dataset}>
    <Dropdown trigger={['click']} autoFocus destroyOnHidden classNames={{ root: 'task-scope-menu' }} menu={{ items, selectedKeys: [activeKey],
      onClick: ({ key }) => {
        if (key === activeKey) return;
        if (key === manageKey) { onManage(); return; }
        onSelect(key === defaultKey ? undefined : key.slice('dataset:'.length));
      },
    }}>
      <Button className="task-scope-trigger" size="small" disabled={disabled || changing} aria-haspopup="menu"
        icon={dataset ? <DatabaseOutlined /> : <FolderOpenOutlined />} aria-label={text.scope + ' · ' + scopeName} title={scopeName}>
        <span className="task-scope-name">{scopeName}</span><DownOutlined className="task-scope-chevron" aria-hidden="true" />
      </Button>
    </Dropdown>
    {showAttachments && <span className="task-scope-files" aria-live="polite" title={filenames.join('\n') || undefined}>
      <FileOutlined aria-hidden="true" />
      <span className="task-scope-count">{changing ? text.changing : count ? text.selected(count) : text.empty}</span>
      {!changing && count > 0 && filenames[0] && <span className="task-scope-filename">{filenames[0]}</span>}
    </span>}
  </div>;
}
