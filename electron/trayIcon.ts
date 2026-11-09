import { app, nativeImage, NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from './logger'
import { solidBitmap, TRAY_REPRESENTATIONS } from './trayAssets'

/** Folder holding the icon files: `resources/icons` when packaged, `build` during development. */
export function iconDirectory(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(app.getAppPath(), 'build')
}

export type TrayIconReport = { source: 'png-set' | 'ico' | 'fallback'; empty: boolean; size: { width: number; height: number }; directory: string }

/**
 * Builds the tray image with one representation per Windows scale factor so the shell picks a
 * pixel-exact bitmap at 100/125/150/200/300 %. Falls back to the multi-size ICO and finally to a
 * generated solid bitmap. The result is never empty.
 */
export function loadTrayIcon(logger?: Logger): { image: NativeImage; report: TrayIconReport } {
  const directory = iconDirectory()
  const report = (image: NativeImage, source: TrayIconReport['source']): { image: NativeImage; report: TrayIconReport } =>
    ({ image, report: { source, empty: image.isEmpty(), size: image.getSize(), directory } })

  try {
    const image = nativeImage.createEmpty()
    for (const { size, scaleFactor } of TRAY_REPRESENTATIONS) {
      const file = path.join(directory, 'tray', `tray-${size}.png`)
      if (fs.existsSync(file)) image.addRepresentation({ scaleFactor, buffer: fs.readFileSync(file) })
    }
    if (!image.isEmpty()) return report(image, 'png-set')
    logger?.warn('Tray PNG set missing or unreadable', directory)
  } catch (error) { logger?.warn('Could not build the tray icon from PNG files', error) }

  try {
    const image = nativeImage.createFromPath(path.join(directory, 'icon.ico'))
    if (!image.isEmpty()) return report(image, 'ico')
    logger?.warn('Tray ICO missing or unreadable', directory)
  } catch (error) { logger?.warn('Could not load the tray ICO', error) }

  logger?.error('Using generated fallback tray icon')
  return report(nativeImage.createFromBitmap(solidBitmap(32), { width: 32, height: 32, scaleFactor: 2 }), 'fallback')
}
