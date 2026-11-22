'use client';

import { ApiError, type ProjectSessionGroup } from '@kortix/sdk';
import { useCreateWorkspaceSessionGroup, useUpdateWorkspaceSessionGroup } from '@kortix/sdk/react';
import { useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Field, FieldGroup, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Textarea } from '../../primitives/textarea';
import { errorToast, successToast } from '../../primitives/toast';
import { ProjectIconField } from '../projects/modal/project-icon-field';
import { spaceIconValue } from './space-icon';

/** The API's limits (`SESSION_GROUP_NAME_MAX`, `SESSION_GROUP_DESCRIPTION_MAX`). */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 2000;

/**
 * Create a space, or edit one (`space` set): its name and what it is for.
 * Every session of the space reads the description at turn start
 * (apps/api session-where.ts). A taken name shows in the dialog; any other
 * failure is a toast and the dialog stays open with what was typed.
 */
export function SpaceFormModal({
  projectId,
  space,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  /** Null: create a new space. */
  space: ProjectSessionGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a create or a save, with the space as the API returned it. */
  onSaved?: (space: ProjectSessionGroup) => void;
}) {
  const t = useTranslations('sessionSpaces');
  const create = useCreateWorkspaceSessionGroup(projectId);
  const update = useUpdateWorkspaceSessionGroup(projectId);
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /** The icon picked in this dialog; null follows the name's suggestion (create) or keeps the stored one (edit). */
  const [icon, setIcon] = useState<ProjectSessionGroup['icon']>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Reset the fields each time the dialog opens, for the space it opens on.
  const [syncedFor, setSyncedFor] = useState<[boolean, string | null]>([false, null]);
  if (syncedFor[0] !== open || syncedFor[1] !== (space?.group_id ?? null)) {
    setSyncedFor([open, space?.group_id ?? null]);
    if (open) {
      setName(space?.name ?? '');
      setDescription(space?.description ?? '');
      setIcon(space?.icon ?? null);
      setProblem(null);
    }
  }

  const pending = create.isPending || update.isPending;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const iconChanged = JSON.stringify(icon ?? null) !== JSON.stringify(space?.icon ?? null);
  const unchanged =
    space !== null && trimmedName === space.name && trimmedDescription === (space.description ?? '') && !iconChanged;

  const submit = async () => {
    if (!trimmedName || unchanged || pending) return;
    setProblem(null);
    try {
      const saved = space
        ? await update.mutateAsync({
            groupId: space.group_id,
            input: { name: trimmedName, description: trimmedDescription || null, ...(iconChanged ? { icon } : {}) },
          })
        : await create.mutateAsync({ name: trimmedName, description: trimmedDescription || null, ...(icon ? { icon } : {}) });
      successToast(space ? t('saved') : t('created'));
      onOpenChange(false);
      onSaved?.(saved);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'group_name_taken') setProblem(t('nameTaken'));
      else if (code === 'group_limit') setProblem(t('limit'));
      else if (code === 'invalid_icon') errorToast(t('iconSaveFailed'));
      else errorToast(space ? t('saveFailed') : t('createFailed'));
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{space ? t('editTitle') : t('createTitle')}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <form
            id={`${nameId}-form`}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={nameId}>{t('nameLabel')}</FieldLabel>
                <div className="flex items-center gap-2">
                  {/* Until a pick, the face follows the name as you type: the icon the space gets if you pick nothing. */}
                  <ProjectIconField
                    value={spaceIconValue({ name: trimmedName || space?.name || '', icon })}
                    onChange={(emoji) => setIcon({ emoji })}
                    onGlyphChange={(glyph) => setIcon({ glyph })}
                    onClear={icon ? () => setIcon(null) : undefined}
                    disabled={pending}
                  />
                  <Input
                    id={nameId}
                    autoFocus
                    value={name}
                    maxLength={NAME_MAX}
                    placeholder={t('namePlaceholder')}
                    aria-invalid={problem ? true : undefined}
                    onChange={(event) => {
                      setName(event.target.value);
                      setProblem(null);
                    }}
                  />
                </div>
                {problem ? (
                  <p className="text-destructive text-xs" role="alert">
                    {problem}
                  </p>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={descriptionId}>{t('descriptionLabel')}</FieldLabel>
                <Textarea
                  id={descriptionId}
                  value={description}
                  maxLength={DESCRIPTION_MAX}
                  minHeight={96}
                  maxHeight={280}
                  placeholder={t('descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
              </Field>
            </FieldGroup>
          </form>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={`${nameId}-form`}
            size="sm"
            className="w-full sm:w-auto"
            aria-busy={pending || undefined}
            disabled={!trimmedName || unchanged || pending}
          >
            {space ? t('save') : t('create')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
