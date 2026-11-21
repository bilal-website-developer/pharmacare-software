import React, { useEffect, useState } from 'react';
import { Check, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react';
import { supabase } from '../utils/supabase';
import PharmaLogo from './PharmaLogo';
import { APP_NAME } from '../constants/brand';
import {
  desktopActivate,
  desktopGetLicenseStatus,
  desktopLogin,
  desktopRestorePortableBackup,
  desktopSetupAdmin,
  isDesktopMode,
  LocalLicenseStatus,
} from '../services/localApi';

interface LoginViewProps {
  onLogin: (userId: string, email: string) => Promise<void>;
  initialError?: string;
  heading?: string;
  subtitle?: string;
  onCancel?: () => void;
  cancelLabel?: string;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLogin,
  initialError = '',
  heading,
  subtitle,
  onCancel,
  cancelLabel = 'Back',
}) => {
  const desktopMode = isDesktopMode();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [licenseStatus, setLicenseStatus] = useState<LocalLicenseStatus | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const [createdAdmin, setCreatedAdmin] = useState<{
    id: string;
    email: string;
    recoveryKey: string;
  } | null>(null);
  const [recoveryKeySaved, setRecoveryKeySaved] = useState(false);
  const [recoveryCopyNotice, setRecoveryCopyNotice] = useState('');
  const [restoreRecoveryKey, setRestoreRecoveryKey] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState('');

  useEffect(() => {
    if (!desktopMode) return;
    void desktopGetLicenseStatus()
      .then(setLicenseStatus)
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : 'Could not load license status.');
      });
  }, [desktopMode]);

  const handleActivation = async () => {
    setLoading(true);
    setError('');
    try {
      setLicenseStatus(await desktopActivate(activationCode.trim()));
      setActivationCode('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Activation failed.');
    } finally {
      setLoading(false);
    }
  };

  const handlePortableRestore = async () => {
    setRestoreBusy(true);
    setRestoreNotice('');
    try {
      const restored = await desktopRestorePortableBackup(restoreRecoveryKey.trim());
      if (restored) setRestoreNotice('Backup restored. Sign in with an account from that backup.');
    } catch (caught) {
      setRestoreNotice(caught instanceof Error ? caught.message : 'Could not restore the portable backup.');
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (desktopMode) {
        if (licenseStatus?.requiresAdminSetup) {
          const result = await desktopSetupAdmin({
            username: email.trim(),
            password,
            fullName: fullName.trim(),
          });
          setCreatedAdmin({
            id: result.user.id,
            email: result.user.email || result.user.username,
            recoveryKey: result.recoveryKey,
          });
          setRecoveryKeySaved(false);
          setPassword('');
          return;
        }
        const user = await desktopLogin(email.trim(), password);
        await onLogin(user.id, user.email || user.username);
        setPassword('');
        return;
      }
      if (!supabase) throw new Error('Supabase is not configured. Contact your administrator.');
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      if (!data.user?.email) throw new Error('Authentication returned no user email.');
      await onLogin(data.user.id, data.user.email);
      setPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-3 py-4 font-inter text-text sm:px-5">
      <div className="w-full max-w-md">
        <header className="mb-3 space-y-1.5 text-center">
          <PharmaLogo size={9} className="mx-auto" />
          <p className="text-xs text-muted">{subtitle ?? `Sign in to ${APP_NAME}`}</p>
        </header>
        <section className="overflow-hidden rounded-card border border-border bg-white shadow-lg">
          <div className="h-1.5 bg-primary" />
          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5 p-4 sm:p-5">
            {heading && <h1 className="text-center text-lg font-black text-text">{heading}</h1>}
            {desktopMode && licenseStatus?.status === 'UNACTIVATED' && (
              <div className="space-y-3 rounded-control border border-warning/30 bg-warning/5 p-3">
                <h2 className="text-sm font-bold text-text">Activate this pharmacy</h2>
                <input
                  value={activationCode}
                  onChange={(event) => setActivationCode(event.target.value)}
                  required
                  placeholder="Enter activation code"
                  className="w-full rounded-control border border-border px-3 py-2 text-sm"
                />
                <button type="button" onClick={() => void handleActivation()} disabled={loading} className="w-full rounded-control bg-primary px-4 py-2 text-sm font-bold text-white">
                  Activate
                </button>
              </div>
            )}
            {desktopMode && (
              <div className="space-y-2 rounded-control border border-border bg-surface p-3">
                <h2 className="text-sm font-bold text-text">Restore a portable backup</h2>
                <p className="text-xs text-muted">On a new PC, restore with the recovery key before signing in.</p>
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="Recovery key for portable backup"
                  value={restoreRecoveryKey}
                  onChange={(event) => setRestoreRecoveryKey(event.target.value)}
                  placeholder="Shop Admin recovery key"
                  className="w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => void handlePortableRestore()}
                  disabled={restoreBusy || restoreRecoveryKey.trim().length !== 43}
                  className="w-full rounded-control border border-border px-3 py-2 text-sm font-bold text-text disabled:opacity-50"
                >
                  {restoreBusy ? 'Restoring…' : 'Choose backup and restore'}
                </button>
                {restoreNotice && <p role="status" className="text-xs text-muted">{restoreNotice}</p>}
              </div>
            )}
            {desktopMode && licenseStatus?.requiresAdminSetup && (
              <p className="rounded-control border border-success/30 bg-success/5 p-3 text-sm text-text">
                Activation complete for <strong>{licenseStatus.shopName}</strong>. Create the first Shop Admin account.
              </p>
            )}
            {desktopMode && licenseStatus?.message && licenseStatus.status !== 'UNACTIVATED' && (
              <p role="status" className="text-sm text-warning">{licenseStatus.message}</p>
            )}
            {(!desktopMode || licenseStatus?.isActivated) && (
              <>
                {desktopMode && licenseStatus?.requiresAdminSetup && (
                  <div>
                    <label htmlFor="fullName" className="mb-1.5 block text-xs font-bold tracking-wide">FULL NAME</label>
                    <input
                      id="fullName"
                      name="name"
                      autoComplete="name"
                      required
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      className="w-full rounded-control border border-border bg-white px-3 py-2.5 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
                  </div>
                )}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-bold tracking-wide">
                {desktopMode ? 'USERNAME' : 'EMAIL'}
              </label>
              <div className="relative">
                <UserRound aria-hidden="true" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="email"
                  name="email"
                  type={desktopMode ? 'text' : 'email'}
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-control border border-border bg-white py-2.5 pl-10 pr-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </div>
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-bold tracking-wide">
                PASSWORD
              </label>
              <div className="relative">
                <LockKeyhole aria-hidden="true" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-control border border-border bg-white py-2.5 pl-10 pr-11 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
            >
              <Check size={17} aria-hidden="true" />
              {loading
                ? (licenseStatus?.requiresAdminSetup ? 'Creating account…' : 'Signing in…')
                : (licenseStatus?.requiresAdminSetup ? 'Create Shop Admin' : 'Sign In to System')}
            </button>
              </>
            )}
            <p className="text-center text-xs text-muted">Forgot your password? Contact your administrator.</p>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="w-full rounded-control border border-border px-4 py-2 text-sm font-semibold text-text hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {cancelLabel}
              </button>
            )}
          </form>
        </section>
      </div>
      {createdAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-key-title"
            className="w-full max-w-lg space-y-4 rounded-card bg-white p-6 shadow-xl"
          >
            <h2 id="recovery-key-title" className="text-lg font-black text-text">Save your pharmacy recovery key</h2>
            <p className="text-sm text-text">
              This key is needed to restore an exported backup on a new PC. It is shown only now; keep it somewhere safe and separate from this computer.
            </p>
            <input
              aria-label="Pharmacy recovery key"
              readOnly
              value={createdAdmin.recoveryKey}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full select-all rounded-control border border-border bg-surface px-3 py-3 font-mono text-sm"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(createdAdmin.recoveryKey)
                    .then(() => setRecoveryCopyNotice('Recovery key copied.'))
                    .catch(() => setRecoveryCopyNotice('Copy was unavailable; select and copy the key above.'));
                }}
                className="rounded-control border border-border px-3 py-2 text-sm font-semibold text-text"
              >
                Copy key
              </button>
              {recoveryCopyNotice && <span role="status" className="text-xs text-muted">{recoveryCopyNotice}</span>}
            </div>
            <label className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={recoveryKeySaved}
                onChange={(event) => setRecoveryKeySaved(event.target.checked)}
                className="mt-0.5"
              />
              I have saved this recovery key somewhere safe.
            </label>
            <button
              type="button"
              disabled={!recoveryKeySaved}
              onClick={() => {
                const admin = createdAdmin;
                setCreatedAdmin(null);
                void onLogin(admin.id, admin.email);
              }}
              className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue to Pharma Care
            </button>
          </section>
        </div>
      )}
    </main>
  );
};
