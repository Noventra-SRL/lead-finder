import {
  BedDouble,
  Briefcase,
  Building2,
  Coffee,
  Dumbbell,
  Hotel,
  KeyRound,
  Pill,
  Pizza,
  Scissors,
  ShoppingBag,
  Sparkles,
  Stethoscope,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { BusinessCategoryId } from '../api/client.ts';

/*
 * Icona e colore di ogni categoria commerciale. Nessuna foto: senza un'immagine reale dell'attività si mostra l'icona
 * della categoria (mai foto d'archivio inventate). I colori sono tenui e usati solo per riconoscere la categoria.
 */

export const CATEGORY_ICON: Record<BusinessCategoryId, LucideIcon> = {
  farmacie: Pill,
  parafarmacie: Pill,
  bnb_case_vacanza: BedDouble,
  hotel_ricettive: Hotel,
  ristoranti: UtensilsCrossed,
  bar_caffetterie: Coffee,
  pizzerie: Pizza,
  parrucchieri_barbieri: Scissors,
  centri_estetici: Sparkles,
  palestre_fitness: Dumbbell,
  studi_medici: Stethoscope,
  studi_professionali: Briefcase,
  negozi: ShoppingBag,
  agenzie_immobiliari: KeyRound,
  officine: Wrench,
  altre_attivita: Building2,
};

/** Tono del colore della categoria (classi in dashboard.css). */
export const CATEGORY_TONE: Record<
  BusinessCategoryId,
  'blue' | 'green' | 'orange' | 'violet' | 'rose' | 'teal' | 'slate'
> = {
  farmacie: 'green',
  parafarmacie: 'teal',
  bnb_case_vacanza: 'rose',
  hotel_ricettive: 'blue',
  ristoranti: 'orange',
  bar_caffetterie: 'orange',
  pizzerie: 'orange',
  parrucchieri_barbieri: 'violet',
  centri_estetici: 'violet',
  palestre_fitness: 'teal',
  studi_medici: 'teal',
  studi_professionali: 'slate',
  negozi: 'blue',
  agenzie_immobiliari: 'slate',
  officine: 'slate',
  altre_attivita: 'slate',
};

export function CategoryTile({ category }: { category: BusinessCategoryId | null }) {
  const Icon = category ? CATEGORY_ICON[category] : Building2;
  return (
    <span className={`cat-tile cat-tone--${category ? CATEGORY_TONE[category] : 'slate'}`} aria-hidden="true">
      <Icon size={20} strokeWidth={1.8} />
    </span>
  );
}

export function CategoryBadge({ category, label }: { category: BusinessCategoryId | null; label: string }) {
  return <span className={`cat-badge cat-tone--${category ? CATEGORY_TONE[category] : 'slate'}`}>{label}</span>;
}
