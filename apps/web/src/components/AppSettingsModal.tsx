import { AppstoreOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Modal, Select, Tabs, Typography, message } from 'antd';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OwnedAppCard } from '@aap/shared';
import { api } from '../api/client';
import { withBase } from '../lib/base';
import { AppEnvModal, type AppEnvSaveRef } from './AppEnvModal';

type AppVisibility = 'public' | 'login' | 'private';

export function AppSettingsModal({ app, open, onClose, onSaved, theme }: {
  app: OwnedAppCard | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  theme: 'light' | 'dark';
}): ReactNode {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('basic');
  const [saving, setSaving] = useState(false);
  const [icon, setIcon] = useState<string | null>(null);
  const [iconUploading, setIconUploading] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const envSaveRef = useRef<AppEnvSaveRef['current']>(null);

  useEffect(() => {
    if (!app || !open) return;
    form.setFieldsValue({
      name: app.name,
      description: app.description,
      visibility: app.visibility,
    });
    setIcon(app.icon);
    setActiveTab('basic');
  }, [app?.id, form, open]);

  async function uploadIcon(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file || !app) return;
    if (file.size > 2 * 1024 * 1024) {
      message.error('应用图标不能超过 2 MB');
      event.target.value = '';
      return;
    }

    setIconUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const result = await api<{ icon: string }>(`/api/apps/${encodeURIComponent(app.id)}/icon`, {
        method: 'POST',
        json: { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) },
      });
      setIcon(result.icon);
      onSaved();
      message.success('应用图标已上传并保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '应用图标上传失败');
    } finally {
      setIconUploading(false);
      event.target.value = '';
    }
  }

  async function resetIcon(): Promise<void> {
    if (!app) return;
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/icon`, { method: 'DELETE' });
      setIcon(null);
      onSaved();
      message.success('已恢复默认图标');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '恢复默认图标失败');
    }
  }

  async function save(values: {
    name: string;
    description: string;
    visibility: AppVisibility;
  }): Promise<void> {
    if (!app) return;
    setSaving(true);
    let envSaved = false;
    try {
      if (app.kind === 'package' && envSaveRef.current) {
        envSaved = await envSaveRef.current();
        if (!envSaved) return;
      }
      const result = await api<{ pointsAwarded: number }>(`/api/apps/${encodeURIComponent(app.id)}/settings`, {
        method: 'PUT',
        json: values,
      });
      message.success(
        result.pointsAwarded > 0
          ? `设置已保存，公开发布获得 ${result.pointsAwarded} 积分`
          : `「${values.name.trim()}」的设置已保存`,
      );
      if (result.pointsAwarded > 0) void qc.invalidateQueries({ queryKey: ['membership'] });
      onSaved();
      onClose();
    } catch (err) {
      const detail = err instanceof Error ? err.message : '应用设置保存失败';
      message.error(envSaved ? `环境变量已保存，但应用设置保存失败：${detail}` : detail);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`应用设置${app ? `：${app.name}` : ''}`}
      open={open}
      onCancel={onClose}
      width={640}
      destroyOnClose
      rootClassName={`aap-account-modal aap-account-modal--${theme}`}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" loading={saving} onClick={() => form.submit()}>保存设置</Button>,
      ]}
    >
      {app ? (
        <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'basic',
                label: '基本信息与可见范围',
                children: (
                  <>
                    <Typography.Paragraph type="secondary">
                      更新应用卡片展示的信息，并设置哪些用户可以发现和访问此应用。
                    </Typography.Paragraph>
                    <Form.Item label="应用图标" extra="点击图标或上传按钮选择 PNG、JPEG、GIF 或 WebP 图片，最大 2 MB。">
                      <div className="aap-app-icon-picker">
                        <button
                          type="button"
                          className="aap-app-icon-picker__preview"
                          aria-label="上传应用图标"
                          onClick={() => iconInputRef.current?.click()}
                        >
                          {icon?.startsWith(`/api/apps/${encodeURIComponent(app.id)}/icon/`)
                            ? <img src={withBase(icon)} alt="" />
                            : icon || app.name.slice(0, 1) || <AppstoreOutlined />}
                        </button>
                        <div className="aap-app-icon-picker__actions">
                          <Button icon={<UploadOutlined />} loading={iconUploading} onClick={() => iconInputRef.current?.click()}>
                            上传图标
                          </Button>
                          {icon ? (
                            <Button disabled={iconUploading} onClick={() => void resetIcon()}>
                              恢复默认
                            </Button>
                          ) : null}
                          <input
                            ref={iconInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/gif,image/webp"
                            onChange={(event) => void uploadIcon(event)}
                            disabled={iconUploading}
                            style={{ display: 'none' }}
                          />
                        </div>
                      </div>
                    </Form.Item>
                    <Form.Item
                      name="name"
                      label="应用名称"
                      rules={[
                        { required: true, whitespace: true, message: '请填写应用名称' },
                        { max: 191, message: '应用名称不能超过 191 个字符' },
                      ]}
                    >
                      <Input maxLength={191} placeholder="输入应用名称" />
                    </Form.Item>
                    <Form.Item
                      name="description"
                      label="应用描述"
                      extra="简要介绍应用用途，将显示在应用卡片上。"
                      rules={[{ max: 4000, message: '描述不能超过 4000 个字符' }]}
                    >
                      <Input.TextArea rows={3} maxLength={4000} showCount placeholder="介绍这个应用能做什么" />
                    </Form.Item>
                    {app.isClone ? (
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="站内应用克隆固定为仅自己可见；删除克隆后会归还一个可克隆名额。"
                      />
                    ) : null}
                    <Form.Item name="visibility" label="可见范围" rules={[{ required: true }]}>
                      <Select
                        disabled={app.isClone}
                        popupClassName={`aap-account-modal-select-dropdown aap-account-modal-select-dropdown--${theme}`}
                        options={[
                          { value: 'public', label: '公开 — 所有人都可以发现并访问' },
                          { value: 'login', label: '站内 — 他人可克隆，不可直接访问' },
                          { value: 'private', label: '仅自己 — 只有你可以发现并访问' },
                        ]}
                      />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'env',
                label: '环境变量',
                children: app.kind === 'package' ? (
                  <AppEnvModal
                    appId={app.id}
                    appName={app.name}
                    open={open && activeTab === 'env'}
                    onClose={() => undefined}
                    theme={theme}
                    embedded
                    saveRef={envSaveRef}
                  />
                ) : (
                  <Typography.Paragraph type="secondary">
                    此应用不是 AWPK 包，无需配置应用环境变量。
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
        </Form>
      ) : null}
    </Modal>
  );
}
