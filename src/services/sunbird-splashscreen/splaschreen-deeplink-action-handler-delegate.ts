import {
  ContentFilterConfig,
  PreferenceKey,
  ProfileConstants,
  appLanguages,
  ProgressPopupContext,
  IgnoreTelemetryPatters
} from '@app/app/app.constant';
import { Inject, Injectable } from '@angular/core';
import { Router, NavigationExtras } from '@angular/router';
import { Events, PopoverController } from '@ionic/angular';
import { Observable, of } from 'rxjs';
import {
  PageAssembleService,
  FrameworkService,
  ContentService,
  SharedPreferences,
  HttpServerError,
  NetworkError,
  AuthService, ProfileType, Content,
  ProfileService, Channel,
  GetFrameworkCategoryTermsRequest,
  CachedItemRequestSourceFrom,
  FrameworkCategoryCode,
  FrameworkUtilService,
  Profile,
  FrameworkCategoryCodesGroup,
  ProfileSource,
  CorrelationData,
  TelemetryObject,
  TelemetryService,
  ContentDetailRequest,
  ChildContentRequest,
  ContentImportRequest,
  StorageService,
  ContentImport,
  Rollup
} from 'sunbird-sdk';
import { SplashscreenActionHandlerDelegate } from './splashscreen-action-handler-delegate';
import { ContentType, MimeType, EventTopics, RouterLinks, LaunchType } from '../../app/app.constant';
import { AppGlobalService } from '../app-global-service.service';
import { TelemetryGeneratorService } from '@app/services/telemetry-generator.service';
import { CommonUtilService } from '@app/services/common-util.service';
import { PageId, InteractType, Environment, ID, CorReleationDataType } from '../telemetry-constants';
import { AppVersion } from '@ionic-native/app-version/ngx';
import { UtilityService } from '../utility-service';
import { SbPopoverComponent } from '@app/app/components/popups/sb-popover/sb-popover.component';
import { LoginHandlerService } from '../login-handler.service';
import { TranslateService } from '@ngx-translate/core';
import { FormAndFrameworkUtilService } from '../formandframeworkutil.service';
import { QRScannerResultHandler } from '../qrscanresulthandler.service';
import { ExternalChannelOverrideListener } from './external-channel-override-interface';
import { initTabs, GUEST_TEACHER_TABS } from '@app/app/module.service';
import { ContainerService } from '../container.services';
import { ContentUtil } from '@app/util/content-util';
import * as qs from 'qs';
import { SbProgressLoader, Context as SbProgressLoaderContext } from '../sb-progress-loader.service';

@Injectable()
export class SplaschreenDeeplinkActionHandlerDelegate implements SplashscreenActionHandlerDelegate, ExternalChannelOverrideListener {
  private savedPayloadUrl: any;

  private _isDelegateReady = false;
  private isOnboardingCompleted = false;
  private loginPopup: any;
  private currentAppVersionCode: number;
  private progressLoaderId: string;
  private childContent;
  private isChildContentFound;

  // should delay the deeplinks until tabs is loaded- gets triggered from Resource components
  set isDelegateReady(val: boolean) {
    this._isDelegateReady = val;
    if (val && this.savedPayloadUrl) {
      this.handleDeeplink(this.savedPayloadUrl);
      this.savedPayloadUrl = null;
    }
  }

  constructor(
    @Inject('CONTENT_SERVICE') private contentService: ContentService,
    @Inject('SHARED_PREFERENCES') private preferences: SharedPreferences,
    @Inject('AUTH_SERVICE') public authService: AuthService,
    @Inject('PROFILE_SERVICE') private profileService: ProfileService,
    @Inject('PAGE_ASSEMBLE_SERVICE') private pageAssembleService: PageAssembleService,
    @Inject('FRAMEWORK_SERVICE') private frameworkService: FrameworkService,
    @Inject('FRAMEWORK_UTIL_SERVICE') private frameworkUtilService: FrameworkUtilService,
    @Inject('TELEMETRY_SERVICE') private telemetryService: TelemetryService,
    @Inject('STORAGE_SERVICE') private storageService: StorageService,
    private telemetryGeneratorService: TelemetryGeneratorService,
    private commonUtilService: CommonUtilService,
    private appGlobalServices: AppGlobalService,
    private events: Events,
    private router: Router,
    private appVersion: AppVersion,
    private utilityService: UtilityService,
    private popoverCtrl: PopoverController,
    private loginHandlerService: LoginHandlerService,
    public translateService: TranslateService,
    private formFrameWorkUtilService: FormAndFrameworkUtilService,
    private qrScannerResultHandler: QRScannerResultHandler,
    private container: ContainerService,
    private sbProgressLoader: SbProgressLoader
  ) {
    this.eventToSetDefaultOnboardingData();
  }

  onAction(payload: any): Observable<undefined> {
    if (payload && payload.url) {
      this.handleDeeplink(payload.url);
    }
    return of(undefined);
  }

  // This method is called only when the user redirects directly from the Playstore
  checkUtmContent(utmVal: string): void {
    const utmRegex = new RegExp(String.raw`(?:utm_content=(?<utm_content>[^&]*))`);
    const res = utmRegex.exec(utmVal);
    if (res && res.groups && res.groups.utm_content && res.groups.utm_content.length) {
      const payload = { url: res.groups.utm_content };
      this.onAction(payload);
    }
  }

  private async handleDeeplink(payloadUrl: string) {
    const dialCode = await this.qrScannerResultHandler.parseDialCode(payloadUrl);
    const urlRegex = new RegExp(await this.formFrameWorkUtilService.getDeeplinkRegexFormApi());
    const urlMatch = payloadUrl.match(urlRegex);

    // TODO: Is supported URL or not.

    let identifier;
    if (urlMatch && urlMatch.groups && Object.keys(urlMatch.groups).length) {
      identifier = urlMatch.groups.quizId || urlMatch.groups.contentId || urlMatch.groups.courseId;
    }

    await this.sbProgressLoader.show(this.generateProgressLoaderContext(payloadUrl, identifier, dialCode));

    this.generateUtmTelemetryEvent(identifier, dialCode, payloadUrl);

    // Read version code from deeplink.
    const requiredVersionCode = this.getQueryParamValue(payloadUrl, 'vCode');
    // Check if deelink is compatible with the current app.
    if (requiredVersionCode && !(await this.isAppCompatible(requiredVersionCode))) {
      this.closeProgressLoader();
      this.upgradeAppPopover(requiredVersionCode);
    } else {
      this.isOnboardingCompleted =
        (await this.preferences.getString(PreferenceKey.IS_ONBOARDING_COMPLETED).toPromise() === 'true') ? true : false;

      // const session = await this.authService.getSession().toPromise();

      // If onboarding not completed
      if (!this.isOnboardingCompleted) {  // && !session
        // skip info popup
        this.appGlobalServices.skipCoachScreenForDeeplink = true;

        // Set onboarding data if available in query params. e.g. channel, role, lang
        await this.setOnboradingData(payloadUrl);
      }

      this.handleNavigation(payloadUrl, identifier, dialCode);
    }
  }

  private generateProgressLoaderContext(url, identifier, dialCode): SbProgressLoaderContext {
    if (this.progressLoaderId) {
      this.closeProgressLoader();
    }
    this.progressLoaderId = dialCode || identifier || ProgressPopupContext.DEEPLINK;
    const deeplinkUrl: URL = new URL(url);
    const channelSlug = deeplinkUrl.searchParams.get('channel');
    if (channelSlug) {
      return {
        id: this.progressLoaderId,
        ignoreTelemetry: {
          when: {
            interact: IgnoreTelemetryPatters.IGNORE_DEEPLINK_PAGE_ID_EVENTS,
            impression: IgnoreTelemetryPatters.IGNORE_CHANNEL_IMPRESSION_EVENTS
          }
        }
      };
    } else if (dialCode) {
      return {
        id: this.progressLoaderId,
        ignoreTelemetry: {
          when: {
            interact: IgnoreTelemetryPatters.IGNORE_DIAL_CODE_PAGE_ID_EVENTS,
            impression: IgnoreTelemetryPatters.IGNORE_DEEPLINK_PAGE_ID_EVENTS
          }
        }
      };
    } else if (identifier) {
      return {
        id: this.progressLoaderId,
        ignoreTelemetry: {
          when: {
            interact: IgnoreTelemetryPatters.IGNORE_DEEPLINK_PAGE_ID_EVENTS,
            impression: IgnoreTelemetryPatters.IGNORE_DEEPLINK_PAGE_ID_EVENTS
          }
        }
      };
    }
    return {
      id: this.progressLoaderId
    };
  }

  private closeProgressLoader() {
    this.sbProgressLoader.hide({
      id: this.progressLoaderId
    });
    this.progressLoaderId = undefined;
  }

  private generateUtmTelemetryEvent(identifier, dialCode, url) {
    // TODO: Here identifier and dialcode both could be undefined.
    // TODO: What needs to pass if deeplink in not having neither identifier nor dialcode.
    const telemetryObject = new TelemetryObject(identifier ? identifier : dialCode, identifier ? 'Content' : 'qr', undefined);
    const utmUrl = url.slice(url.indexOf('?') + 1);
    const params: { [param: string]: string } = qs.parse(utmUrl);
    const utmcData: CorrelationData[] = [];

    if (utmUrl !== url) {
      ContentUtil.genrateUTMCData(params).forEach((element) => {
        utmcData.push(element);
      });
    }

    const corRelationData: CorrelationData[] = [{
      id: CorReleationDataType.DEEPLINK,
      type: CorReleationDataType.ACCESS_TYPE
    }];
    if (utmcData && utmcData.length) {
      this.telemetryService.updateCampaignParameters(utmcData);
      this.telemetryGeneratorService.generateUtmInfoTelemetry(params, PageId.HOME, telemetryObject, corRelationData);
    }

    return utmcData;
  }

  private getQueryParamValue(payloadUrl: string, queryParam: string): string {
    const url = new URL(payloadUrl);
    return url.searchParams.get(queryParam);
  }

  private async isAppCompatible(requiredVersionCode) {
    this.currentAppVersionCode = await this.utilityService.getAppVersionCode();

    // If requiredVersionCode is available then should display upgrade popup is installed version is less than the expected appVesion.
    return (this.currentAppVersionCode
      && requiredVersionCode
      && this.currentAppVersionCode >= requiredVersionCode);
  }

  private async upgradeAppPopover(requiredVersionCode) {
    const packageName = await this.appVersion.getPackageName();
    const playStoreLink = `https://play.google.com/store/apps/details?id=${packageName}`;
    const result: any = {
      type: 'optional',
      title: 'UPDATE_APP_SUPPORT_TITLE',
      isOnboardingCompleted: this.isOnboardingCompleted,
      requiredVersionCode,
      currentAppVersionCode: (this.currentAppVersionCode).toString(),
      isFromDeeplink: true,
      actionButtons: [
        {
          action: 'yes',
          label: 'UPDATE_APP_BTN_ACTION_YES',
          link: playStoreLink
        }
      ]
    };
    await this.appGlobalServices.openPopover(result);
  }

  private async setOnboradingData(payloadUrl) {
    const lang = this.getQueryParamValue(payloadUrl, 'lang');
    this.setAppLanguage(lang);

    const userType = this.getQueryParamValue(payloadUrl, 'role');
    this.setUserType(userType);

    const channelSlug = this.getQueryParamValue(payloadUrl, 'channel');
    if (channelSlug) {
      const orgSearchRequest = {
        filters: {
          slug: channelSlug,
          isRootOrg: true
        }
      };

      try {
        const result = await this.frameworkService.searchOrganization(orgSearchRequest).toPromise();
        const org: any = result.content && result.content[0];
        if (org) {
          const channelId = org.identifier;
          this.setProfileData(channelId, payloadUrl);

          // Set the channel for page assemble and load the channel specifc course page is available.
          this.pageAssembleService.setPageAssembleChannel({ channelId });

          setTimeout(() => {
            this.events.publish(EventTopics.COURSE_PAGE_ASSEMBLE_CHANNEL_CHANGE);
          }, 500);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  private async setAppLanguage(langCode: string) {
    const selctedLangCode = await this.preferences.getString(PreferenceKey.SELECTED_LANGUAGE_CODE).toPromise();
    const selectedLangLabel = await this.preferences.getString(PreferenceKey.SELECTED_LANGUAGE).toPromise();
    if (!selctedLangCode && !selectedLangLabel) {
      let languageDetail;
      if (!langCode) {
        // Set the default to english if not available.
        langCode = 'en';
      }
      const LangList = appLanguages;
      languageDetail = LangList.find(i => i.code === langCode);

      await this.preferences.putString(PreferenceKey.SELECTED_LANGUAGE_CODE, languageDetail.code).toPromise();
      this.translateService.use(languageDetail.code);

      await this.preferences.putString(PreferenceKey.SELECTED_LANGUAGE, languageDetail.name).toPromise();
    }
  }

  private async setUserType(userType) {
    if (!(userType && Object.values(ProfileType).includes(userType))) {
      userType = ProfileType.TEACHER;
    }
    const selectedUserType = await this.preferences.getString(PreferenceKey.SELECTED_USER_TYPE).toPromise();
    if (!selectedUserType) {
      await this.preferences.putString(PreferenceKey.SELECTED_USER_TYPE, userType).toPromise();
    }
  }

  private async setProfileData(channelId: string, payloadUrl) {
    try {
      const channelDetails: Channel = await this.frameworkService.getChannelDetails({ channelId }).toPromise();
      const frameworkId = channelDetails.defaultFramework;

      const categories = [
        { code: FrameworkCategoryCode.BOARD, prevCode: null },
        { code: FrameworkCategoryCode.MEDIUM, prevCode: FrameworkCategoryCode.BOARD },
        { code: FrameworkCategoryCode.GRADE_LEVEL, prevCode: FrameworkCategoryCode.MEDIUM }
      ];
      const categoryData: any = {};
      for (const category of categories) {
        const boardCategoryTermsRequet: GetFrameworkCategoryTermsRequest = {
          from: category.code === FrameworkCategoryCode.BOARD ? CachedItemRequestSourceFrom.SERVER : null,
          frameworkId,
          requiredCategories: FrameworkCategoryCodesGroup.DEFAULT_FRAMEWORK_CATEGORIES,
          currentCategoryCode: category.code,
          language: this.translateService.currentLang,
          selectedTermsCodes: category.prevCode ? [category.prevCode] : null
        };
        const terms = await this.frameworkUtilService.getFrameworkCategoryTerms(boardCategoryTermsRequet).toPromise();
        categoryData[category.code] = terms[0].code;
      }

      // Get the active profile
      const activeSessionProfile = await this.profileService.getActiveSessionProfile({
        requiredFields: ProfileConstants.REQUIRED_FIELDS
      }).toPromise();

      const userType = await this.preferences.getString(PreferenceKey.SELECTED_USER_TYPE).toPromise();
      const updateProfileRequest: Profile = {
        ...activeSessionProfile,
        syllabus: [frameworkId],
        board: [categoryData[FrameworkCategoryCode.BOARD]],
        medium: [categoryData[FrameworkCategoryCode.MEDIUM]],
        grade: [categoryData[FrameworkCategoryCode.GRADE_LEVEL]],
        handle: 'Guest1',
        profileType: userType as any,
        source: ProfileSource.LOCAL
      };
      const profile: Profile = await this.profileService.updateProfile(updateProfileRequest).toPromise();

      // TODO: need to revisit below section
      // initTabs(this.container, GUEST_TEACHER_TABS);
      // this.events.publish('refresh:profile');
      this.appGlobalServices.guestUserProfile = profile;

      this.commonUtilService.handleToTopicBasedNotification();

      setTimeout(async () => {
        this.appGlobalServices.setOnBoardingCompleted();
        // this.navigateToCourse(payload.courseId, payloadUrl);
        this.loginHandlerService.setDefaultProfileDetails();
      }, 1000);

      this.events.publish('onboarding-card:completed', { isOnBoardingCardCompleted: true });
      this.events.publish('refresh:profile');
      this.appGlobalServices.guestUserProfile = profile;
      this.telemetryGeneratorService.generateProfilePopulatedTelemetry(
        PageId.HOME, profile, 'auto', Environment.ONBOARDING, ContentUtil.extractBaseUrl(payloadUrl)
      );

      this.isOnboardingCompleted = true;
    } catch (e) {
      this.closeProgressLoader();
    }
  }

  private async handleNavigation(payloadUrl, identifier, dialCode) {
    if (!this._isDelegateReady) {
      this.closeProgressLoader();
      this.savedPayloadUrl = payloadUrl;
    } else if (dialCode) {
      this.telemetryGeneratorService.generateAppLaunchTelemetry(LaunchType.DEEPLINK, payloadUrl);
      this.router.navigate([RouterLinks.SEARCH],
        {
          state: {
            dialCode,
            source: PageId.HOME,
            corRelation: this.getCorrelationList(payloadUrl)
          }
        });
    } else if (identifier) {
      const content = await this.getContentData(identifier);
      if (!content) {
        this.closeProgressLoader();
      } else {
        this.navigateContent(identifier, true, content, payloadUrl);
      }
    // } else if (isAnyRouteAvailable) {
    //   this.router.navigate([RouterLinks.SEARCH]);
    } else {
      // Show generic error message 'Deeplink not suppoerted'
      this.closeProgressLoader();
    }
  }

  /////////////////////////////////////////////////

  async navigateContent(identifier, isFromLink = false, content?: Content | null, payloadUrl?: string) {
    try {
      this.appGlobalServices.resetSavedQuizContent();
      if (!content) {
        content = await this.getContentData(identifier);
      }

      if (isFromLink) {
        this.telemetryGeneratorService.generateAppLaunchTelemetry(LaunchType.DEEPLINK, payloadUrl);
      }

      // this.appGlobalServices.skipCoachScreenForDeeplink = true;
      if (content && content.contentType.toLowerCase() === ContentType.COURSE.toLowerCase()) {
        this.navigateToCourseDetail(identifier, content, payloadUrl);
      } else if (content && content.mimeType === MimeType.COLLECTION) {
        if (this.router.url && this.router.url.indexOf(RouterLinks.COLLECTION_DETAIL_ETB) !== -1) {
          this.events.publish(EventTopics.DEEPLINK_COLLECTION_PAGE_OPEN, { content });
          this.closeProgressLoader();
          return;
        }
        this.router.navigate([RouterLinks.COLLECTION_DETAIL_ETB],
          {
            state: {
              content,
              corRelation: this.getCorrelationList(payloadUrl)
            }
          });
      } else {
        if (!this.commonUtilService.networkInfo.isNetworkAvailable) {
          this.commonUtilService.showToast('NEED_INTERNET_FOR_DEEPLINK_CONTENT');
          this.appGlobalServices.skipCoachScreenForDeeplink = false;
          this.closeProgressLoader();
          return;
        }
        if (content && content.contentData && content.contentData.status === ContentFilterConfig.CONTENT_STATUS_UNLISTED) {
          this.navigateQuizContent(identifier, content, isFromLink, payloadUrl);
        } else {
          await this.router.navigate([RouterLinks.CONTENT_DETAILS],
            {
              state: {
                content,
                corRelation: this.getCorrelationList(payloadUrl)
              }
            });
        }
      }
    } catch (err) {
      this.closeProgressLoader();
      console.log(err);
    }
  }

  private async navigateQuizContent(identifier, content, isFromLink, payloadUrl) {
    this.appGlobalServices.limitedShareQuizContent = identifier;
    if (isFromLink) {
      this.limitedSharingContentLinkClickedTelemery();
    }
    if (!this.appGlobalServices.isSignInOnboardingCompleted && this.appGlobalServices.isUserLoggedIn()) {
      this.closeProgressLoader();
      return;
    }
    if (this.router.url && this.router.url.indexOf(RouterLinks.CONTENT_DETAILS) !== -1) {
      this.events.publish(EventTopics.DEEPLINK_CONTENT_PAGE_OPEN, { content, autoPlayQuizContent: true });
      this.closeProgressLoader();
      return;
    }
    await this.router.navigate([RouterLinks.CONTENT_DETAILS],
      {
        state: {
          content, autoPlayQuizContent: true,
          corRelation: this.getCorrelationList(payloadUrl)
        }
      });
  }

  private getContentData(contentId): Promise<Content | null> {
    return new Promise(async resolve => {
      const content = await this.contentService.getContentDetails({ contentId }).toPromise()
        .catch(e => {
          if (HttpServerError.isInstance(e)) {
            this.commonUtilService.showToast('ERROR_FETCHING_DATA');
          } else if (NetworkError.isInstance(e)) {
            this.commonUtilService.showToast('NEED_INTERNET_FOR_DEEPLINK_CONTENT');
          } else {
            this.commonUtilService.showToast('ERROR_CONTENT_NOT_AVAILABLE');
          }
          return null;
        });
      resolve(content);
    });
  }

  private limitedSharingContentLinkClickedTelemery(): void {
    const corRelationList = [];
    corRelationList.push({ id: ID.QUIZ, type: CorReleationDataType.DEEPLINK });
    this.telemetryGeneratorService.generateInteractTelemetry(
      InteractType.QUIZ_DEEPLINK,
      '',
      Environment.HOME,
      undefined,
      undefined,
      undefined,
      undefined,
      corRelationList,
      ID.DEEPLINK_CLICKED
    );
  }

  private async showLoginWithoutOnboardingPopup(quizId) {
    this.appGlobalServices.resetSavedQuizContent();
    this.loginPopup = await this.popoverCtrl.create({
      component: SbPopoverComponent,
      componentProps: {
        sbPopoverMainTitle: this.commonUtilService.translateMessage('YOU_MUST_LOGIN_TO_ACCESS_QUIZ_CONTENT'),
        metaInfo: this.commonUtilService.translateMessage('QUIZ_CONTENTS_ONLY_REGISTERED_USERS'),
        sbPopoverHeading: this.commonUtilService.translateMessage('OVERLAY_SIGN_IN'),
        isNotShowCloseIcon: true,
        actionsButtons: [
          {
            btntext: this.commonUtilService.translateMessage('OVERLAY_SIGN_IN'),
            btnClass: 'popover-color',
            isInternetNeededMessage: 'NEED_INTERNET_FOR_DEEPLINK_CONTENT'
          }
        ]
      },
      cssClass: 'sb-popover info',
    });
    await this.loginPopup.present();

    const { data } = await this.loginPopup.onDidDismiss();
    if (data && data.canDelete) {
      this.loginHandlerService.signIn();
      this.appGlobalServices.limitedShareQuizContent = quizId;
    }
    this.loginPopup = null;
  }

  // This method is called only when a deeplink is clicked before Onboarding is not completed
  eventToSetDefaultOnboardingData(): void {
    this.events.subscribe(EventTopics.SIGN_IN_RELOAD, () => {
      if (!this.isOnboardingCompleted) {
        this.setAppLanguage(undefined);
        this.setUserType(undefined);
      }
    });
  }

  async onChannelDetected(event): Promise<boolean> {
    if (this.isOnboardingCompleted) {
      this.navigateToCourse(event.courseId, event.url);
      return true;
    }

    this.setAppLanguage(event.extras.profile.langCode);
    this.setUserType(event.extras.profile.userType);

    if (await this.setCourseOnboardingFlow(event)) {
      // this.appGlobalServices.skipCoachScreenForDeeplink = true;
      return true;
    }
    return false;
  }

  async navigateToCourse(courseId, payloadUrl) {
    if (courseId) {
      const content: any = await this.getContentData(courseId);
      if (content && content.contentType === ContentType.COURSE.toLowerCase()) {
        this.navigateToCourseDetail(content.identifier, content, payloadUrl, false, true);
        await this.sbProgressLoader.hide({ id: 'login' });
      }
    } else {
      this.router.navigateByUrl(RouterLinks.TABS_COURSE);
      await this.sbProgressLoader.hide({ id: 'login' });
    }
  }

  async navigateToCourseDetail(identifier, content: Content | null, payloadUrl: string, isOnboardingSkipped = false, isFromChannelDeeplink = false) {
    let childContentId;
    if (payloadUrl) {
      childContentId = this.getQueryParamValue(payloadUrl, 'moduleId');
    }
    if (!childContentId && payloadUrl) {
      childContentId = this.getQueryParamValue(payloadUrl, 'contentId');
    }

    this.isChildContentFound = false;
    this.childContent = undefined;

    if (childContentId) {
      try {
        if (content && content.isAvailableLocally) {
          this.childContent = await this.getChildContents(childContentId);
        } else {
          this.importContent([identifier], false);
          content = await this.getContentHeirarchy(identifier);
          await this.getChildContent(content, childContentId);
        }
      } catch (e) {
        console.error(e);
      }
    }
    if (this.childContent) {
      if (this.childContent.mimeType === MimeType.COLLECTION) {
        const chapterParams: NavigationExtras = {
          state: {
            courseContent: content,
            chapterData: this.childContent,
            isOnboardingSkipped,
            isFromDeeplink: true
          }
        };

        this.router.navigate([`/${RouterLinks.CURRICULUM_COURSES}/${RouterLinks.CHAPTER_DETAILS}`],
          chapterParams);
      } else {
        this.router.navigate([RouterLinks.CONTENT_DETAILS], {
          state: {
            content: this.childContent,
            depth: 1,
            // contentState,  // check in chapter detail page
            isChildContent: true,
            // corRelation: this.corRelationList,
            corRelation: undefined,
            isCourse: true,
            // course: this.updatedCourseCardData, // check in chapter detail page
            isOnboardingSkipped
          }
        });
      }
    } else {
      this.router.navigate([RouterLinks.ENROLLED_COURSE_DETAILS],
        {
          state: {
            content,
            isOnboardingSkipped,
            isFromChannelDeeplink,
            corRelation: this.getCorrelationList(payloadUrl)
          }
        });
    }
  }

  private setCourseOnboardingFlow(event) {

    return new Promise(async resolve => {
      try {
        const channelDetails: Channel = await this.frameworkService.getChannelDetails({ channelId: event.channelId }).toPromise();
        const frameworkId = channelDetails.defaultFramework;
        const syllabus = frameworkId;

        const categories = [
          { code: FrameworkCategoryCode.BOARD, prevCode: null },
          { code: FrameworkCategoryCode.MEDIUM, prevCode: FrameworkCategoryCode.BOARD },
          { code: FrameworkCategoryCode.GRADE_LEVEL, prevCode: FrameworkCategoryCode.MEDIUM }
        ];
        const categoryData: any = {};
        for (const category of categories) {
          const boardCategoryTermsRequet: GetFrameworkCategoryTermsRequest = {
            from: category.code === FrameworkCategoryCode.BOARD ? CachedItemRequestSourceFrom.SERVER : null,
            frameworkId,
            requiredCategories: FrameworkCategoryCodesGroup.DEFAULT_FRAMEWORK_CATEGORIES,
            currentCategoryCode: category.code,
            language: this.translateService.currentLang,
            selectedTermsCodes: category.prevCode ? [category.prevCode] : null
          };
          const terms = (await this.frameworkUtilService.getFrameworkCategoryTerms(boardCategoryTermsRequet).toPromise());
          categoryData[category.code] = terms[0].code;
        }

        const payload = {
          syllabus,
          board: categoryData[FrameworkCategoryCode.BOARD],
          medium: categoryData[FrameworkCategoryCode.MEDIUM],
          grade: categoryData[FrameworkCategoryCode.GRADE_LEVEL],
          courseId: event.courseId
        };
        await this.submitProfileSettings(payload, event.url);
        resolve(true);
      } catch (e) {
        resolve(false);
        this.closeProgressLoader();
      }
    });
  }

  private async submitProfileSettings(payload, payloadUrl) {
    try {
      const activeSessionProfile = await this.profileService.getActiveSessionProfile({
        requiredFields: ProfileConstants.REQUIRED_FIELDS
      }).toPromise();
      const userType = await this.preferences.getString(PreferenceKey.SELECTED_USER_TYPE).toPromise();

      const updateProfileRequest: Profile = {
        ...activeSessionProfile,
        syllabus: [payload.syllabus],
        board: [payload.board],
        medium: [payload.medium],
        grade: [payload.grade],
        handle: 'Guest1',
        profileType: userType as any,
        source: ProfileSource.LOCAL
      };

      const profile: Profile = await this.profileService.updateProfile(updateProfileRequest).toPromise();
      initTabs(this.container, GUEST_TEACHER_TABS);
      this.events.publish('refresh:profile');
      this.appGlobalServices.guestUserProfile = profile;

      this.commonUtilService.handleToTopicBasedNotification();

      setTimeout(async () => {
        this.appGlobalServices.setOnBoardingCompleted();
        this.navigateToCourse(payload.courseId, payloadUrl);
        this.loginHandlerService.setDefaultProfileDetails();
      }, 1000);

      this.events.publish('onboarding-card:completed', { isOnBoardingCardCompleted: true });
      this.events.publish('refresh:profile');
      this.appGlobalServices.guestUserProfile = profile;
      this.telemetryGeneratorService.generateProfilePopulatedTelemetry(
        PageId.HOME, profile, 'auto', Environment.ONBOARDING, ContentUtil.extractBaseUrl(payloadUrl)
      );

    } catch (e) {
      console.log(e);
    }
    return;
  }

  private getCorrelationList(payloadUrl): Array<CorrelationData> {
    const corRelationList: Array<CorrelationData> = [{
      id: ContentUtil.extractBaseUrl(payloadUrl),
      type: CorReleationDataType.SOURCE
    }];
    return corRelationList;
  }

  async getChildContents(identifier) {
    const childContentRequest: ChildContentRequest = {
      contentId: identifier,
      hierarchyInfo: null
    };
    return this.contentService.getChildContents(childContentRequest).toPromise();
  }

  async getContentHeirarchy(identifier: string) {
    const request: ContentDetailRequest = {
      contentId: identifier
    };

    return this.contentService.getContentHeirarchy(request).toPromise();
  }

  async getChildContent(content, childContentId) {
    if (content.identifier === childContentId) {
      this.childContent = content;
      this.isChildContentFound = true;
    } else if (!this.isChildContentFound && content && content.children) {
      content.children.forEach((ele) => {
        if (!this.isChildContentFound) {
          this.getChildContent(ele, childContentId);
        }
      });
    }
    return (this.childContent);
  }

  private importContent(identifiers: Array<string>, isChild: boolean) {
    const contentImportRequest: ContentImportRequest = {
      contentImportArray: this.getImportContentRequestBody(identifiers, isChild),
      contentStatusArray: ['Live'],
      fields: ['appIcon', 'name', 'subject', 'size', 'gradeLevel'],
    };
    // // Call content service
    this.contentService.importContent(contentImportRequest).toPromise();
  }

  private getImportContentRequestBody(identifiers: Array<string>, isChild: boolean): Array<ContentImport> {
    const rollUpMap: { [key: string]: Rollup } = {};
    const requestParams: ContentImport[] = [];
    identifiers.forEach((value) => {
      requestParams.push({
        isChildContent: isChild,
        destinationFolder: this.storageService.getStorageDestinationDirectoryPath(),
        contentId: value,
        correlationData: [],
        rollUp: rollUpMap[value]
      });
    });

    return requestParams;
  }
}
