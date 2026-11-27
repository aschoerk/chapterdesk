import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';

interface ConfigTab {
  path: string;
  labelKey: string;
}

/** A tool page reachable from the settings sidebar (not a settings subpage). */
interface ConfigTool {
  path: string;
  labelKey: string;
}

@Component({
  selector: 'app-config-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './config-shell.component.html',
  styleUrl: './config-shell.component.css'
})
export class ConfigShellComponent {
  readonly i18n = inject(I18nService);

  readonly tabs: ConfigTab[] = [
    { path: '/config/appearance', labelKey: 'config.nav.appearance' },
    { path: '/config/providers', labelKey: 'config.nav.providers' },
    { path: '/config/tasks', labelKey: 'config.nav.tasks' },
    { path: '/config/prompts', labelKey: 'config.nav.prompts' },
    { path: '/config/shortcuts', labelKey: 'config.nav.shortcuts' }
  ];

  /**
   * Tool pages that leave the settings area. The German → English translator
   * lives here instead of the main navigation: it is an authoring aid, not part
   * of the story workflow.
   */
  readonly tools: ConfigTool[] = [
    { path: '/translate', labelKey: 'config.nav.translator' }
  ];
}