'use client';

// New item: the title first; when, owner and notes are optional. Opened from
// the header or from a day's "+" (that day is preset).
import type { CalendarAssigneeInput, CalendarItem } from '@kortix/sdk';
import { useWorkspaceCalendarActions } from '@kortix/sdk/react';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Field, FieldGroup, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { errorToast } from '../../primitives/toast';
import { OwnerMenu, WhenField } from './calendar-panel';
import type { CalendarDirectory } from './calendar-people';
import { MentionTextarea } from './mention-textarea';

function ownerPreview(input: CalendarAssigneeInput | null): CalendarItem['assignee'] {
  if (!input) return null;
  if ('user_id' in input) return { kind: 'person', user_id: input.user_id };
  if ('agent' in input) return { kind: 'agent', agent: input.agent };
  return null;
}

export function NewItemModal({
  projectId,
  open,
  day,
  directory,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  /** Preset all-day date (`YYYY-MM-DD`), or null for no date. */
  day: string | null;
  directory: CalendarDirectory;
  onOpenChange: (open: boolean) => void;
  onCreated: (item: CalendarItem) => void;
}) {
  const t = useTranslations('calendar');
  const actions = useWorkspaceCalendarActions(projectId);
  // The page remounts this modal for every opening (`key`), so each one starts empty on `day`.
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState<{ starts_at: string | null; all_day: boolean }>(() =>
    day ? { starts_at: `${day}T00:00:00.000Z`, all_day: true } : { starts_at: null, all_day: false },
  );
  const [owner, setOwner] = useState<CalendarAssigneeInput | null>(null);

  const create = () => {
    const name = title.trim();
    if (!name || actions.create.isPending) return;
    actions.create.mutate(
      { title: name, notes, ...when, assignee: owner },
      {
        onSuccess: (item) => {
          onOpenChange(false);
          onCreated(item);
        },
        onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <ModalHeader>
            <ModalTitle>{t('newItem')}</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="calendar-new-title">{t('titleLabel')}</FieldLabel>
                <Input
                  id="calendar-new-title"
                  autoFocus
                  maxLength={200}
                  value={title}
                  placeholder={t('titlePlaceholder')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>{t('when')}</FieldLabel>
                <WhenField startsAt={when.starts_at} allDay={when.all_day} onChange={setWhen} />
              </Field>
              <Field>
                <FieldLabel>{t('owner')}</FieldLabel>
                <OwnerMenu assignee={ownerPreview(owner)} directory={directory} onChange={setOwner} />
              </Field>
              <Field>
                <FieldLabel>{t('notes')}</FieldLabel>
                <MentionTextarea
                  value={notes}
                  onChange={setNotes}
                  directory={directory}
                  ariaLabel={t('notes')}
                  placeholder={t('notesPlaceholder')}
                  minHeight={72}
                  onSubmit={create}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!title.trim() || actions.create.isPending} aria-busy={actions.create.isPending}>
              {t('create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
