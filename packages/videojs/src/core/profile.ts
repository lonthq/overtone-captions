import { closestProfile, getProfile, type OvertoneDocument, type Profile } from 'overtone-format';

export interface Size { width: number; height: number }

/** The profile named by `option` if the document has it, else the closest to the picture's shape (spec §14.3). */
export function chooseProfile(doc: OvertoneDocument, option: string, picture: Size): Profile | undefined {
  const named = option === 'auto' ? undefined : getProfile(doc, option);
  return named ?? closestProfile(doc.profiles, picture.width / picture.height);
}
