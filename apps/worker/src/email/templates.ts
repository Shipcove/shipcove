/** Templates par défaut (personnalisables dans l'administration : table `email_templates`). */
export const DEFAULT_TEMPLATES: Record<string, { subject: string; bodyText: string; bodyHtml?: string }> = {
  'auth.verify_email': {
    subject: 'Vérifiez votre adresse email',
    bodyText: 'Bonjour {{name}},\n\nConfirmez votre adresse en ouvrant ce lien (valable 48 h) :\n{{link}}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.',
  },
  'auth.password_reset': {
    subject: 'Réinitialisation de votre mot de passe',
    bodyText: 'Bonjour {{name}},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 h) :\n{{link}}\n\nSi vous n’avez rien demandé, ignorez ce message ; votre mot de passe reste inchangé.',
  },
  'auth.invitation': {
    subject: '{{inviter}} vous invite à rejoindre Shipcove',
    bodyText: 'Bonjour,\n\n{{inviter}} vous invite à rejoindre Shipcove.\nCréez votre compte avec ce lien (valable 7 jours) :\n{{link}}',
  },
  'admin.smtp_test': {
    subject: 'Test de configuration SMTP',
    bodyText: 'Ce message confirme que la configuration SMTP de Shipcove fonctionne.',
  },
  'notification.generic': {
    subject: '{{title}}',
    bodyText: 'Bonjour {{name}},\n\n{{body}}\n\n{{link}}',
  },
};

/** Substitution `{{var}}` ; échappement HTML pour la variante HTML. */
export function render(tpl: string, vars: Record<string, string>, html = false): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k] ?? '';
    return html ? v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) : v;
  });
}
