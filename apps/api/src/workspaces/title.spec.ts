import { describe, expect, it } from 'vitest';
import { cleanTitle, parseTitle, shortTitle, titleResponseFormat } from './workspaces.service.js';

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

  it('lit la sortie contrainte (JSON) ou le texte libre, borné au nombre de caractères', () => {
    expect(parseTitle('{"title": "Migration vers Tailwind CSS"}', 60)).toBe('Migration vers Tailwind CSS');
    expect(parseTitle('<think>Je réfléchis…</think>{"title":"Test de paiement instable"}', 60)).toBe('Test de paiement instable');
    expect(parseTitle('Migration vers Tailwind', 60)).toBe('Migration vers Tailwind');
    // Contrainte ignorée par le fournisseur : coupé sur une fin de mot.
    const long = parseTitle('{"title": "Migration complète du projet vers Tailwind CSS avec suppression de Bootstrap"}', 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
    expect(parseTitle('<think>coupé', 60)).toBe('');
  });

  it('schéma de sortie : un titre requis, de longueur bornée', () => {
    const f = titleResponseFormat(45) as { json_schema: { schema: { properties: { title: { maxLength: number } }; required: string[] } } };
    expect(f.json_schema.schema.properties.title.maxLength).toBe(45);
    expect(f.json_schema.schema.required).toEqual(['title']);
  });

  it('repli : début du message, coupé proprement', () => {
    expect(shortTitle('Passe le projet en Tailwind CSS')).toBe('Passe le projet en Tailwind CSS');
    expect(shortTitle('a '.repeat(80)).endsWith('…')).toBe(true);
    expect(shortTitle('mot '.repeat(30), 30).length).toBeLessThanOrEqual(30);
  });
});
