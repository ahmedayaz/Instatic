/**
 * Account → Profile tab.
 *
 * Shows the current user's identity (avatar + display name + email + role)
 * and lets them upload or remove a profile picture. Without an upload, the
 * avatar falls back to the deterministic Gravatar identicon derived from
 * the user's email, so every user has a recognisable picture out of the
 * box.
 *
 * Future work — display-name edit, email change, password change — slots
 * in next to the upload card as additional sections; the avatar surface
 * lives on its own card so it can carry its own busy/error state without
 * a giant section-wide form. Display-name + email edits ride on top of
 * the existing `/me` plumbing (`PATCH /me` is the natural next endpoint).
 */
import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@ui/components/Button'
import {
  deleteCurrentUserAvatar,
  uploadCurrentUserAvatar,
  type CmsCurrentUser,
} from '@core/persistence'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { UserAvatar } from '@admin/shared/UserAvatar'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface ProfileTabProps {
  user: CmsCurrentUser
}

type AvatarStatus = { tone: 'info' | 'error'; message: string } | null

async function uploadAvatarHelper(
  file: File,
  setBusy: (v: null | 'upload' | 'remove') => void,
  setSessionUser: (user: CmsCurrentUser) => void,
  setStatus: (v: AvatarStatus) => void,
): Promise<void> {
  try {
    const updated = await uploadCurrentUserAvatar(file)
    setSessionUser(updated)
    setStatus({ tone: 'info', message: 'Profile picture updated.' })
  } catch (err) {
    console.error('[profile-tab] avatar upload failed:', err)
    setStatus({
      tone: 'error',
      message: getErrorMessage(err, 'Could not upload avatar.'),
    })
  } finally {
    setBusy(null)
  }
}

async function removeAvatarHelper(
  setBusy: (v: null | 'upload' | 'remove') => void,
  setSessionUser: (user: CmsCurrentUser) => void,
  setStatus: (v: AvatarStatus) => void,
): Promise<void> {
  try {
    const updated = await deleteCurrentUserAvatar()
    setSessionUser(updated)
    setStatus({ tone: 'info', message: 'Profile picture removed.' })
  } catch (err) {
    console.error('[profile-tab] avatar remove failed:', err)
    setStatus({
      tone: 'error',
      message: getErrorMessage(err, 'Could not remove avatar.'),
    })
  } finally {
    setBusy(null)
  }
}

export function ProfileTab({ user }: ProfileTabProps) {
  const setSessionUser = useAdminSessionSetter()
  const [busy, setBusy] = useState<null | 'upload' | 'remove'>(null)
  const [status, setStatus] = useState<AvatarStatus>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const displayName = user.displayName.trim() || user.email
  const hasUploadedAvatar = user.avatarUrl !== null

  function openFilePicker(): void {
    if (busy) return
    fileInputRef.current?.click()
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    // Reset the value so picking the same filename twice still fires
    // `change` — needed for re-upload after an error.
    event.target.value = ''
    if (!file) return

    setBusy('upload')
    setStatus(null)
    await uploadAvatarHelper(file, setBusy, setSessionUser, setStatus)
  }

  async function handleRemove(): Promise<void> {
    if (busy) return
    setBusy('remove')
    setStatus(null)
    await removeAvatarHelper(setBusy, setSessionUser, setStatus)
  }

  return (
    <section className={styles.section} aria-labelledby="account-profile-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="account-profile-title">Profile</h2>
          <p>Your name, email, and role across the install.</p>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.profileGrid}>
          <div className={styles.avatarColumn}>
            <UserAvatar user={user} size={96} alt={`Avatar for ${displayName}`} />
            <div className={styles.avatarActions}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={openFilePicker}
                disabled={busy !== null}
                aria-busy={busy === 'upload'}
                data-testid="profile-avatar-upload"
              >
                <span>
                  {busy === 'upload'
                    ? 'Uploading…'
                    : hasUploadedAvatar
                      ? 'Change picture'
                      : 'Upload picture'}
                </span>
              </Button>
              {hasUploadedAvatar && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  tone="danger"
                  onClick={() => void handleRemove()}
                  disabled={busy !== null}
                  aria-busy={busy === 'remove'}
                  data-testid="profile-avatar-remove"
                >
                  <span>{busy === 'remove' ? 'Removing…' : 'Remove'}</span>
                </Button>
              )}
            </div>
            <p className={styles.avatarHint}>JPEG, PNG, GIF, or WebP — 5 MB maximum.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className={styles.hiddenFileInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void handleFileChange(event)}
              data-testid="profile-avatar-file"
            />
          </div>
          <div className={styles.profileFields}>
            <div className={styles.profileField}>
              <span className={styles.profileFieldLabel}>Name</span>
              <span className={styles.profileFieldValue}>{displayName}</span>
            </div>
            <div className={styles.profileField}>
              <span className={styles.profileFieldLabel}>Email</span>
              <span className={styles.profileFieldValue}>{user.email}</span>
            </div>
            <div className={styles.profileField}>
              <span className={styles.profileFieldLabel}>Role</span>
              <span className={styles.profileFieldValue}>{user.role.name}</span>
            </div>
          </div>
        </div>
        {status && (
          <p
            className={status.tone === 'error' ? styles.error : styles.cardStatus}
            role={status.tone === 'error' ? 'alert' : 'status'}
            data-testid="profile-avatar-status"
          >
            {status.message}
          </p>
        )}
      </div>
    </section>
  )
}
