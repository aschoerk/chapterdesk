import { Component, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast/toast.service';

/**
 * Non-modal toast notifications: a fixed, bottom-right stack of auto-dismissing
 * messages served by {@link ToastService}. Mounted once in the app root like
 * the other global overlays. Kept deliberately dumb — it only renders the
 * service's `toasts()` signal and forwards manual dismissals.
 */
@Component({
  selector: 'app-toast-host',
  standalone: true,
  templateUrl: './toast-host.component.html',
  styleUrl: './toast-host.component.css'
})
export class ToastHostComponent {
  readonly toast = inject(ToastService);
  readonly i18n = inject(I18nService);
}