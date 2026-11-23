import { DeleteOutlined, EditOutlined, EllipsisOutlined, MessageOutlined, PushpinFilled, PushpinOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input, Modal, Spin } from 'antd';
import type { InputRef } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assistantConversationTitle, conversationTitleLimit, normalizeConversationTitle } from './office';
import type { AssistantTask } from './office';

interface Props {
  tasks: AssistantTask[];
  activeId: string;
  query: string;
  changeQuery: (query: string) => void;
  ready: boolean;
  disabled: boolean;
  open: (task: AssistantTask) => void;
  remove: (task: AssistantTask) => Promise<boolean>;
  rename: (id: string, title: string) => Promise<boolean>;
  pin: (id: string, pinned: boolean) => Promise<boolean>;
}

export default function AssistantConversations({ tasks, activeId, query, changeQuery, ready, disabled, open, remove, rename, pin }: Props) {
  const { t, i18n } = useTranslation();
  const [dialog, setDialog] = useState<{ id: string; action: 'rename' | 'delete' }>();
  const [menuTaskId, setMenuTaskId] = useState<string>();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<InputRef>(null);
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
  const term = query.trim().normalize('NFKC').toLocaleLowerCase(i18n.language);
  const nameFor = (task: AssistantTask) => assistantConversationTitle(task) || t('assistantUntitledConversation');
  const matches = term ? tasks.filter(task =>
    [nameFor(task), task.draft?.value.title, task.submittedRequest, task.request, task.dataset?.name]
      .some(text => text?.normalize('NFKC').toLocaleLowerCase(i18n.language).includes(term)),
  ) : tasks;
  const ordered = [...matches].sort((first, second) =>
    (second.conversationPinnedAt ?? '').localeCompare(first.conversationPinnedAt ?? '')
    || second.updatedAt.localeCompare(first.updatedAt));
  const selected = dialog && tasks.find(task => task.id === dialog.id);
  const removing = dialog?.action === 'delete';
  const nextName = normalizeConversationTitle(name);
  const canConfirm = Boolean(selected && !disabled && !saving && (removing || nextName));

  async function confirm() {
    if (!selected || !canConfirm) return;
    setSaving(true);
    try {
      const saved = removing ? await remove(selected) : await rename(selected.id, nextName);
      if (saved) setDialog(undefined);
    } finally {
      setSaving(false);
    }
  }

  return <>
    {tasks.length > 0 && <Input className="assistant-conversation-search" size="small" allowClear prefix={<SearchOutlined />}
      placeholder={t('assistantSearchConversations')} aria-label={t('assistantSearchConversations')}
      value={query} onChange={event => changeQuery(event.target.value)} />}
    <div className="assistant-conversation-scroll">
      {matches.length > 0 ? <ul className="assistant-conversation-list">
        {ordered.map(task => {
          const title = nameFor(task);
          const date = new Date(task.updatedAt);
          const validDate = !Number.isNaN(date.getTime());
          const active = task.id === activeId;
          const pinned = Boolean(task.conversationPinnedAt);
          const menuOpen = !disabled && menuTaskId === task.id;
          return <li key={task.id} className="assistant-conversation-item" data-current={active} data-pinned={pinned}>
            <button type="button" className="assistant-conversation-select" title={title} disabled={disabled}
              aria-current={active ? 'true' : undefined} onClick={() => open(task)}>
              {pinned ? <PushpinFilled title={t('assistantPinnedConversation')} /> : <MessageOutlined aria-hidden />}
              <span>
                <strong>{title}</strong>
                {validDate && <time dateTime={task.updatedAt}>{dateFormat.format(date)}</time>}
              </span>
            </button>
            <Dropdown trigger={['click']} placement="bottomRight" destroyOnHidden open={menuOpen}
              onOpenChange={open => setMenuTaskId(current => open ? task.id : current === task.id ? undefined : current)}
              classNames={{ root: 'assistant-conversation-menu' }} menu={{
              items: [
                { key: 'rename', icon: <EditOutlined />, label: t('assistantRenameConversation') },
                { key: 'pin', icon: <PushpinOutlined />, label: t(pinned ? 'assistantUnpinConversation' : 'assistantPinConversation') },
                { type: 'divider' },
                { key: 'delete', icon: <DeleteOutlined />, label: t('assistantRemoveConversation'), danger: true },
              ],
              onClick: ({ key }) => {
                if (!menuOpen) return;
                setMenuTaskId(undefined);
                if (key === 'pin') void pin(task.id, !pinned);
                else if (key === 'rename' || key === 'delete') {
                  setName(title);
                  setDialog({ id: task.id, action: key });
                }
              },
            }}>
              <Button className="assistant-conversation-actions" type="text" size="small" disabled={disabled} icon={<EllipsisOutlined />}
                title={t('assistantConversationActions')} aria-label={t('assistantNamedConversationActions', { title })}
                aria-haspopup="menu" aria-expanded={menuOpen} />
            </Dropdown>
          </li>;
        })}
      </ul> : ready ? <p className="assistant-conversation-empty">{t(term && tasks.length ? 'assistantNoMatchingConversations' : 'assistantNoConversations')}</p>
        : <span className="assistant-conversation-empty" role="status"><Spin size="small" /> {t('assistantLoadingConversations')}</span>}
    </div>
    <Modal open={Boolean(selected)} title={t(removing ? 'assistantRemoveConversation' : 'assistantRenameConversation')} width={390}
      okText={t(removing ? 'assistantConfirmDelete' : 'save')} cancelText={t('cancel')}
      closable={!saving} keyboard={!saving} okButtonProps={{ disabled: !canConfirm, danger: removing }} confirmLoading={saving}
      onCancel={() => { if (!saving) setDialog(undefined); }} onOk={() => void confirm()}
      afterOpenChange={visible => { if (visible && !removing) nameInput.current?.focus({ cursor: 'all' }); }}>
      {removing && selected ? <p className="assistant-conversation-delete-name">{nameFor(selected)}</p> :
        <Input ref={nameInput} aria-label={t('assistantConversationName')} maxLength={conversationTitleLimit}
          value={name} disabled={saving} onChange={event => setName(event.target.value)}
          onPressEnter={event => {
            if (!event.nativeEvent.isComposing && event.keyCode !== 229) void confirm();
          }} />}
    </Modal>
  </>;
}
