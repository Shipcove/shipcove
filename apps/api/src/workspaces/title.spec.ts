import { describe, expect, it } from 'vitest';
import { cleanTitle, shortTitle } from './workspaces.service.js';

describe('titres automatiques', () => {
  it('garde la réponse du modèle, sans guillemets ni préfixe', () => {
    expect(cleanTitle('« Migration vers Tailwind CSS »')).toBe('Migration vers Tailwind CSS');
    expect(cleanTitle('Titre : Corriger le test de paiement.')).toBe('Corriger le test de paiement');
  });

  it('ignore le raisonnement d’un modèle « thinking », complet ou coupé', () => {
    expect(cleanTitle('<think>\nL’utilisateur veut…\n</think>\n\nMigration vers Tailwind')).toBe('Migration vers Tailwind');
    // Budget épuisé pendant le raisonnement : pas de titre (repli sur le début du message).
    expect(cleanTitle('<think>\nOkay, the user wants to migrate')).toBe('');
    expect(cleanTitle('')).toBe('');
  });

  it('repli : début du message, coupé proprement', () => {
    expect(shortTitle('Passe le projet en Tailwind CSS')).toBe('Passe le projet en Tailwind CSS');
    expect(shortTitle('a '.repeat(80)).endsWith('…')).toBe(true);
  });
});
