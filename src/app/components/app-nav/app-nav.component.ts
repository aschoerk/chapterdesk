import { Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { EnvironmentService } from '../../core/settings/environment.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ChatService } from '../../core/chat/chat.service';
import { ShortcutHelpService } from '../../core/dialogs/shortcut-help.service';
import { APP_VERSION } from '../../core/util/version';

interface AppNavLink {
  path: string;
  label: string;
  title: string;
  icon: 'chat' | 'read' | 'projects' | 'topics' | 'personas' | 'import' | 'config' | 'claims' | 'logs';
}

@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './app-nav.component.html',
  styleUrl: './app-nav.component.css'
})
export class AppNavComponent {
  readonly environment = inject(EnvironmentService);
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly chatService = inject(ChatService);
  private readonly shortcutHelp = inject(ShortcutHelpService);

  /** Open the in-app keyboard-shortcut reference (UX playbook §7). */
  openHelp(): void {
    this.shortcutHelp.openDialog();
  }

  readonly versionLabel = APP_VERSION;

  /** Title of the currently selected story/chat, or '' when none. */
  readonly currentChatTitle = computed(() => {
    const id = this.chatService.currentChatId();
    const chat = id ? this.chatService.chats().find(c => c.id === id) : null;
    this.i18n.locale();
    return chat?.title || '';
  });

  constructor() {
    // Keep the window / tab headline (Electron title bar + browser tab) in
    // sync: "Story title — ChapterDesk (1.0.3)".
    effect(() => {
      const title = this.currentChatTitle();
      const brand = `ChapterDesk (${APP_VERSION})`;
      document.title = title ? `${title} — ${brand}` : brand;
    });
  }

  readonly links = computed<AppNavLink[]>(() => {
    this.i18n.locale();
    const t = (k: string) => this.i18n.t(k);
    return [
      { path: '/chat', label: t('nav.stories'), title: t('nav.storiesTitle'), icon: 'chat' },
      { path: '/read', label: t('nav.read'), title: t('nav.readTitle'), icon: 'read' },
      { path: '/logs', label: t('nav.logs'), title: t('nav.logsTitle'), icon: 'logs' },
      { path: '/projects', label: t('nav.environments'), title: t('nav.environmentsTitle'), icon: 'projects' },
      { path: '/topics', label: t('nav.topics'), title: t('nav.topicsTitle'), icon: 'topics' },
      { path: '/personas', label: t('nav.personas'), title: t('nav.personasTitle'), icon: 'personas' },
      { path: '/import', label: t('nav.import'), title: t('nav.importTitle'), icon: 'import' },
      { path: '/claims', label: t('nav.claims'), title: t('nav.claimsTitle'), icon: 'claims' },
      { path: '/config', label: t('nav.settings'), title: t('nav.settingsTitle'), icon: 'config' }
    ];
  });

  logout(): void {
    void this.router.navigateByUrl('/login');
  }
}
