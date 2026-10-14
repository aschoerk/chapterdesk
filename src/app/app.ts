import { Component, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import {AppNavComponent} from './components/app-nav/app-nav.component';
import {ConfirmDialogComponent} from './components/confirm-dialog/confirm-dialog.component';
import {IllustrateDialogComponent} from './components/illustrate-dialog/illustrate-dialog.component';
import {PrependDialogComponent} from './components/prepend-dialog/prepend-dialog.component';
import {RewriteDialogComponent} from './components/rewrite-dialog/rewrite-dialog.component';
import {CreateImageDialogComponent} from './components/create-image-dialog/create-image-dialog.component';
import {ChapterDescriptionsDialogComponent} from './components/chapter-descriptions-dialog/chapter-descriptions-dialog.component';
import {ImageLightboxComponent} from './components/image-lightbox/image-lightbox.component';
import {ThemeService} from './core/theme.service';
import {EnvironmentService} from './core/environment.service';
import {SettingsService} from './core/settings.service';
import {ChatService} from './core/chat.service';
import {ProjectService} from './core/project.service';
import {PersonaService} from './core/persona.service';
import {DemoDataService} from './core/demo-data/demo-data.service';
import {SetupWizardComponent} from './components/setup-wizard/setup-wizard.component';
import {SetupWizardService} from './core/setup-wizard.service';
import {PromptDefaultsService} from './core/prompt-defaults.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavComponent, ConfirmDialogComponent, IllustrateDialogComponent, PrependDialogComponent, RewriteDialogComponent, CreateImageDialogComponent, ChapterDescriptionsDialogComponent, ImageLightboxComponent, SetupWizardComponent],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('chat');
  private readonly theme = inject(ThemeService);
  private readonly environment = inject(EnvironmentService);
  private readonly settings = inject(SettingsService);
  private readonly chatService = inject(ChatService);
  private readonly projectService = inject(ProjectService);
  private readonly personaService = inject(PersonaService);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly demoData = inject(DemoDataService);
  private readonly setupWizard = inject(SetupWizardService);
  readonly router = inject(Router);

  constructor() {
    void this.firstRun();
  }

  /**
   * First-run / onboarding bootstrap:
   *
   *  1. Load the base data (providers/models, chats, projects, topics, personas).
   *  2. On a completely empty workspace, stock the built-in demo data so
   *     structure, reading and editing are explorable WITHOUT an AI model.
   *  3. When no provider is configured yet, run the skippable setup
   *     wizard that guides through provider + default model configuration.
   *
   * Everything is idempotent and never blocks rendering — the wizard appears
   * as an overlay once the app is on screen.
   */
  private async firstRun(): Promise<void> {
    try {
      await Promise.all([
        this.settings.loadAll(),
        this.chatService.loadChats(),
        this.projectService.loadProjects(),
        this.projectService.loadTopics(),
        this.personaService.loadPersonas(),
        this.promptDefaults.load()
      ]);
    } catch (err) {
      console.error('first-run data load failed', err);
    }

    try {
      // Stock the demo workspace on a fresh install, then open the most
      // instructive demo chat so the user lands on real content.
      const demoChatId = await this.demoData.ensureDemoData();
      if (demoChatId) {
        await this.demoData.openFirstDemoChat();
      }
    } catch (err) {
      console.error('first-run demo data load failed', err);
    }

    try {
      // No provider configured → lead the user through setup. Always: there
      // is deliberately NO persistent "dismissed" flag, so the wizard starts
      // again on the next launch while a provider is still missing (a Skip
      // merely closes the current dialog instance).
      if (this.settings.providers().length === 0) {
        await this.setupWizard.open();
      }
    } catch (err) {
      console.error('first-run setup wizard failed', err);
    }
  }

  showNav(): boolean {
    return true;
  }
}
