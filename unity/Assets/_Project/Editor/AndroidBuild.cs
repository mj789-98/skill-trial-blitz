using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using SkillApp.Bridge;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Android player configuration and the Unity-as-a-Library export.
    ///
    /// Everything here is scripted rather than clicked so the export is
    /// reproducible from a clean checkout and reviewable in a diff. A reviewer
    /// can read exactly which player settings this build depends on instead of
    /// discovering them by opening the editor.
    ///
    /// Invoked from the command line:
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath &lt;unity&gt; \
    ///     -executeMethod SkillApp.EditorTools.AndroidBuild.ExportAndroidLibrary
    /// </summary>
    public static class AndroidBuild
    {
        /// <summary>
        /// Where the exported Gradle project lands. React Native's
        /// settings.gradle includes ':unityLibrary' from this directory, so
        /// moving it means updating that file too.
        /// </summary>
        private const string ExportPath = "../app/unity/builds/android";

        private const string SpikeScenePath = "Assets/Scenes/Spike.unity";

        /// <summary>
        /// Point Unity at an Android SDK that actually has command-line tools.
        ///
        /// Unity ships its own SDK, but the Hub's install of the "Command-line
        /// Tools (latest)" component can fail independently of the rest of the
        /// Android module — leaving an SDK that looks present and fails the build
        /// with "Android SDK not found". That is what happened here.
        ///
        /// The -androidSdkPath command-line flag does NOT fix it: the embedded-SDK
        /// toggle takes precedence, so the flag is silently ignored. The toggle
        /// has to be turned off explicitly, which is what this does.
        ///
        /// NDK and JDK stay embedded — Unity's own copies are correct and version
        /// matched, and using them avoids depending on anything machine-specific.
        /// </summary>
        private static void ConfigureAndroidSdk()
        {
            var candidates = new[]
            {
                System.Environment.GetEnvironmentVariable("ANDROID_HOME"),
                System.Environment.GetEnvironmentVariable("ANDROID_SDK_ROOT"),
                Path.Combine(
                    System.Environment.GetFolderPath(
                        System.Environment.SpecialFolder.LocalApplicationData),
                    "Android", "Sdk"),
            };

            foreach (var candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate)) continue;
                // Require the component whose absence causes the failure, rather
                // than just checking the directory exists.
                var probe = Path.Combine(candidate, "cmdline-tools", "latest", "bin");
                if (!Directory.Exists(probe)) continue;

                EditorPrefs.SetBool("SdkUseEmbedded", false);
                EditorPrefs.SetString("AndroidSdkRoot", candidate);
                Debug.Log($"[build] using Android SDK at {candidate}");
                return;
            }

            Debug.LogWarning(
                "[build] no Android SDK with cmdline-tools found; falling back to " +
                "Unity's embedded SDK, which may fail if its command-line tools " +
                "component did not install.");
        }

        [MenuItem("SkillApp/Configure Android Player Settings")]
        public static void ConfigurePlayerSettings()
        {
            ConfigureAndroidSdk();

            var android = NamedBuildTarget.Android;

            PlayerSettings.companyName = "SkillApp";
            PlayerSettings.productName = "SkillApp";
            PlayerSettings.SetApplicationIdentifier(android, "com.skillapp.trial");

            // IL2CPP + ARM64 only. ARM64 is required for Play, and dropping
            // armeabi-v7a roughly halves the size of the native payload — which
            // matters because the Unity library ships inside the RN app.
            PlayerSettings.SetScriptingBackend(android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;

            // 24 is React Native 0.86's floor, so anything lower could not run the
            // host app regardless of what Unity supports.
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel24;
            PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;

            // Portrait only: the reference game is portrait, and letting the Unity
            // view rotate independently of the React Native screens hosting it
            // produces a visibly broken transition.
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
            PlayerSettings.allowedAutorotateToPortrait = true;
            PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
            PlayerSettings.allowedAutorotateToLandscapeLeft = false;
            PlayerSettings.allowedAutorotateToLandscapeRight = false;

            // The host app owns the splash; a Unity splash would flash on top of
            // React Native's own screen every time the game view mounts.
            PlayerSettings.SplashScreen.show = false;

            // Unity is embedded, so it must not paint over the host's UI.
            PlayerSettings.Android.startInFullscreen = false;
            PlayerSettings.Android.renderOutsideSafeArea = false;

            // 60fps target. Frame pacing is 25% of the mark, and leaving vSync to
            // the quality settings makes it inconsistent across devices.
            PlayerSettings.Android.blitType = AndroidBlitType.Auto;
            PlayerSettings.Android.optimizedFramePacing = true;

            // Strip aggressively: the library rides inside the RN APK.
            PlayerSettings.SetManagedStrippingLevel(android, ManagedStrippingLevel.High);

            AssetDatabase.SaveAssets();
            Debug.Log("[build] Android player settings configured.");
        }

        /// <summary>
        /// Build the throwaway spike scene programmatically.
        ///
        /// Authored in code rather than committed as a .unity asset because a
        /// scene YAML is unreviewable in a diff, and this one exists purely to
        /// answer a yes/no question about the embed.
        /// </summary>
        [MenuItem("SkillApp/Create Spike Scene")]
        public static void CreateSpikeScene()
        {
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = "Spinner";
            cube.transform.position = new Vector3(0f, 0f, 4f);

            var camera = Camera.main;
            if (camera != null)
            {
                camera.transform.position = Vector3.zero;
                camera.transform.rotation = Quaternion.identity;
                camera.clearFlags = CameraClearFlags.SolidColor;
                // An obviously non-default colour: it makes "Unity is rendering"
                // distinguishable from "the view is blank" at a glance.
                camera.backgroundColor = new Color(0.06f, 0.35f, 0.45f);
            }

            var bridge = new GameObject(RNBridge.GameObjectName);
            bridge.AddComponent<RNBridge>();

            var spike = bridge.AddComponent<SpikeBehaviour>();
            var so = new SerializedObject(spike);
            so.FindProperty("spinner").objectReferenceValue = cube.transform;
            so.ApplyModifiedPropertiesWithoutUndo();

            Directory.CreateDirectory(Path.GetDirectoryName(SpikeScenePath)!);
            EditorSceneManager.SaveScene(scene, SpikeScenePath);

            EditorBuildSettings.scenes = new[]
            {
                new EditorBuildSettingsScene(SpikeScenePath, true),
            };

            Debug.Log($"[build] spike scene written to {SpikeScenePath}");
        }

        /// <summary>
        /// Export the Unity project as a Gradle library React Native can include.
        /// </summary>
        [MenuItem("SkillApp/Export Android Library")]
        public static void ExportAndroidLibrary()
        {
            ConfigurePlayerSettings();

            if (EditorBuildSettings.scenes.Length == 0)
            {
                Debug.Log("[build] no scenes in build settings; creating the spike scene.");
                CreateSpikeScene();
            }

            // This is what turns a normal APK build into a `unityLibrary` Gradle
            // module — the whole basis of embedding Unity in React Native.
            EditorUserBuildSettings.exportAsGoogleAndroidProject = true;

            var absolute = Path.GetFullPath(
                Path.Combine(Application.dataPath, "..", ExportPath));
            Directory.CreateDirectory(absolute);

            var scenes = System.Array.ConvertAll(
                EditorBuildSettings.scenes, s => s.path);

            var options = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = absolute,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = BuildOptions.Development | BuildOptions.AllowDebugging,
            };

            Debug.Log($"[build] exporting Android library to {absolute}");
            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;

            Debug.Log(
                $"[build] result={summary.result} errors={summary.totalErrors} " +
                $"warnings={summary.totalWarnings} time={summary.totalTime}");

            if (summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
            {
                // THROW rather than EditorApplication.Exit(1).
                //
                // Observed: with -quit also on the command line, the queued quit
                // wins and Unity exits 0 even though the build failed — so the
                // first failed export here reported success to the shell. A
                // BuildFailedException out of -executeMethod is what actually
                // makes batch mode return non-zero, which matters because every
                // later step keys off this exit code.
                throw new BuildFailedException(
                    $"Android export failed: {summary.result}, {summary.totalErrors} error(s). " +
                    "See the Unity log for the underlying cause.");
            }
        }
    }
}
