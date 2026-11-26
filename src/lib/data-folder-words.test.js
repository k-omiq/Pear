import { describe, it, expect, vi } from 'vitest';
import { shownPath, shownText, homePath, sizeText, minutesText, whatHappens, copyingText, plainError } from './data-folder-words.js';

describe('paths shown to the user', () => {
  it('never carry the Windows \\\\?\\ prefix', () => {
    expect(shownPath('\\\\?\\C:\\Users\\me\\Manga Library')).toBe('C:\\Users\\me\\Manga Library');
    expect(shownPath('\\\\?\\UNC\\server\\share\\Manga')).toBe('\\\\server\\share\\Manga');
    expect(shownPath('/Users/me/Manga Library')).toBe('/Users/me/Manga Library');
    expect(shownText('Your data is at \\\\?\\D:\\x. The old copy is at \\\\?\\UNC\\s\\y.')).toBe('Your data is at D:\\x. The old copy is at \\\\s\\y.');
    expect(homePath('/Users/me/Manga Library', '/Users/me')).toBe('~/Manga Library');
    expect(homePath('\\\\?\\C:\\Users\\me\\Manga Library', 'C:\\Users\\me')).toBe('~/Manga Library');
    expect(homePath('/Volumes/X/Manga Library', '/Users/me')).toBe('/Volumes/X/Manga Library');
  });
});

describe('the dialog line', () => {
  it('says the size and the time at 20 MB/s, rounded up to whole minutes', () => {
    expect(sizeText(9.7e9)).toBe('9.7 GB');
    expect(sizeText(120.2e6)).toBe('121 MB');
    expect(minutesText(9.7e9)).toBe('about 9 minutes');
    expect(minutesText(1)).toBe('about 1 minute');
    expect(whatHappens('setup', { hasLibrary: true, bytes: 9.7e9, sameVolume: true })).toBe('Your library moves there. It takes a moment.');
    expect(whatHappens('setup', { hasLibrary: true, bytes: 9.7e9, sameVolume: false })).toBe('Your library (9.7 GB) is copied there. It takes about 9 minutes.');
    expect(whatHappens('join', { hasLibrary: true, bytes: 4.4e9, sameVolume: true })).toBe('Manga Cleaner already uses this folder. Your library (4.4 GB) moves in next to it.');
    expect(whatHappens('join', { hasLibrary: true, bytes: 4.4e9, sameVolume: false })).toBe('Manga Cleaner already uses this folder. Your library (4.4 GB) is copied in next to it. It takes about 4 minutes.');
    expect(whatHappens('setup', { hasLibrary: false })).toBe('Nothing to move.');
    expect(whatHappens('join', { hasLibrary: false })).toBe('Nothing to move.');
    expect(copyingText(5.5e9, 9.7e9)).toBe('Copying 5.5 of 9.7 GB');
  });
});

describe('errors', () => {
  it('map the common system errors to plain words, the rest to one sentence, and log the raw text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(plainError(new Error('Could not copy /a: No space left on device (os error 28)'))).toBe('There is not enough free space on that drive.');
    expect(plainError('Not enough space: the move needs 12 MB and the drive has 3 MB free.')).toBe('There is not enough free space on that drive.');
    expect(plainError('Could not create X: There is not enough space on the disk. (os error 112)')).toBe('There is not enough free space on that drive.');
    expect(plainError('Could not create /x: Permission denied (os error 13)')).toBe('This app is not allowed to write there.');
    expect(plainError('Could not create C:\\x: Access is denied. (os error 5)')).toBe('This app is not allowed to write there.');
    expect(plainError('Could not read /Volumes/X: Device not configured (os error 6)')).toBe('The drive was disconnected.');
    expect(plainError('The process cannot access the file because it is being used by another process. (os error 32)')).toBe('A file is in use by another app.');
    expect(plainError('Could not move /x: Directory not empty (os error 66)')).toBe('The move could not finish.');
    // The app's own refusals are plain words already.
    expect(plainError('CANNOT_TELL: This drive cannot tell whether Manga Cleaner is open. Close it, then confirm.')).toBe('This drive cannot tell whether Manga Cleaner is open. Close it, then confirm.');
    expect(plainError('Manga Cleaner is open. Close it first.')).toBe('Manga Cleaner is open. Close it first.');
    expect(warn).toHaveBeenCalledWith('[data folder]', 'Could not move /x: Directory not empty (os error 66)');
    warn.mockRestore();
  });
});
