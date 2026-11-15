'use client';

// New item: the title first, then two chips (When, People) and the notes.
// Opened from the header or from a day's "+" (that day is preset). The chips
// are the same controls the side panel uses.
import type { CalendarItem, CalendarParticipant } from '@kortix/sdk';
import { useWorkspaceCalendarActions } from '@kortix/sdk/react';
import { useState } from 'react';
import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { errorToast } from '../../primitives/toast';
import { PeoplePicker, type CalendarDirectory } from './calendar-people';
import { NO_DATE, WhenPicker, type WhenValue } from './calendar-when';
import { MentionTextarea } from './mention-textarea';

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
  const [when, setWhen] = useState<WhenValue>(() => (day ? { starts_at: `${day}T00:00:00.000Z`, ends_at: null, all_day: true } : NO_DATE));
  const [people, setPeople] = useState<CalendarParticipant[]>([]);

  const create = () => {
    const name = title.trim();
    if (!name || actions.create.isPending) return;
    actions.create.mutate(
      {
        title: name,
        notes,
        ...when,
        people: people.map((p) => (p.kind === 'person' ? { user_id: p.user_id } : { agent: p.agent })),
      },
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
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              create();
            }
          }}
        >
          <ModalHeader className="pb-4">
            <ModalTitle>{t('newItem')}</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-3">
            <Input
              autoFocus
              size="lg"
              maxLength={200}
              aria-label={t('titleLabel')}
              value={title}
              placeholder={t('titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <WhenPicker value={when} onChange={setWhen} />
              <PeoplePicker value={people} directory={directory} onChange={setPeople} />
            </div>
            <MentionTextarea
              value={notes}
              onChange={setNotes}
              directory={directory}
              ariaLabel={t('notes')}
              placeholder={t('notesPlaceholder')}
              minHeight={64}
              onSubmit={create}
            />
          </ModalBody>
          <ModalFooter className="pb-5">
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
