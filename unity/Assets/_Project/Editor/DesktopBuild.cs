using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// A desktop build, purely for development.
    ///
    /// Not a deliverable — the deliverable is the Android APK. This exists
    /// because tuning game feel needs a fast loop, and the Android path is
    /// IL2CPP-compiled, exported through Gradle and installed over USB, which is
    /// minutes per iteration. A Windows player builds in seconds and runs the
    /// exact same simulation and view code.
    ///
    /// What it does NOT prove: touch input, real frame pacing on a mobile GPU,
    /// haptics, or anything about the React Native embed. Those only come from the
    /// device, so feel is confirmed there before it is called done.
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath unity \
    ///     -executeMethod SkillApp.EditorTools.DesktopBuild.Build
    /// </summary>
    public static class DesktopBuild
    {
        private const string OutputDir = "../build/desktop";

        [MenuItem("SkillApp/Build Desktop (dev only)")]
        public static void Build()
        {
            var absolute = Path.GetFullPath(
                Path.Combine(Application.dataPath, "..", OutputDir));
            Directory.CreateDirectory(absolute);

            // Mono rather than IL2CPP: this build is thrown away constantly and
            // Mono compiles in a fraction of the time. The determinism argument
            // for IL2CPP does not apply — nothing about scoring is decided here,
            // and the parity harness covers the C#/JS agreement separately.
            PlayerSettings.SetScriptingBackend(
                NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);

            var options = new BuildPlayerOptions
            {
                scenes = new[] { ChickenRunScene.ScenePath },
                locationPathName = Path.Combine(absolute, "ChickenRun.exe"),
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = BuildOptions.Development,
            };

            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;
            Debug.Log($"[desktop] result={summary.result} errors={summary.totalErrors}");

            if (summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
            {
                throw new BuildFailedException(
                    $"desktop build failed: {summary.result}, {summary.totalErrors} error(s)");
            }
        }
    }
}
