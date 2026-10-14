import { Linking } from 'react-native';

/**
 * Open a file in the phone's browser, which shows it or downloads it under its
 * own name (the link says `inline` and names it). Its link is minted for the
 * tap and lasts an hour, so a page left open all day still opens what it lists.
 */
export async function openFile(_file: { name: string; contentType: string }, link: () => Promise<string>): Promise<void> {
  await Linking.openURL(await link());
}
