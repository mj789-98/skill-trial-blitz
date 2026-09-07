using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEngine;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Imports the TextMeshPro essential resources.
    ///
    /// TMP ships inside com.unity.ugui but its runtime assets — the default font
    /// atlas, shaders and TMP Settings — are NOT imported with the package. They
    /// sit in a .unitypackage that the editor normally prompts you to import the
    /// first time you add a TMP component.
    ///
    /// In batch mode nothing prompts, so every TMP label renders as nothing at
    /// all, with no error. This does the import explicitly so a clean checkout
    /// builds a working HUD without anyone having to know that.
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath unity \
    ///     -executeMethod SkillApp.EditorTools.TextMeshProSetup.Import
    /// </summary>
    public static class TextMeshProSetup
    {
        private const string SettingsAsset = "Assets/TextMesh Pro/Resources/TMP Settings.asset";

        public static bool IsImported =>
            AssetDatabase.LoadAssetAtPath<Object>(SettingsAsset) != null;

        [MenuItem("SkillApp/Import TextMeshPro Resources")]
        public static void Import()
        {
            if (IsImported)
            {
                Debug.Log("[tmp] essential resources already imported");
                return;
            }

            var package = FindEssentialResources();
            if (package == null)
            {
                Debug.LogError(
                    "[tmp] could not find 'TMP Essential Resources.unitypackage' in the " +
                    "com.unity.ugui package. TMP labels will render blank.");
                return;
            }

            Debug.Log($"[tmp] importing {package}");

            // AssetDatabase.ImportPackage is ASYNCHRONOUS. Under -batchmode -quit
            // the editor exits before the import finishes, so the call appears to
            // succeed and TMP Settings never actually appears — which is exactly
            // what happened on the first attempt.
            //
            // ImportPackageImmediately does the same job synchronously but is
            // internal, so it is called by reflection. If Unity ever removes it,
            // the async path still runs and the guard below reports the truth
            // rather than leaving a silently broken HUD.
            var immediate = typeof(AssetDatabase).GetMethod(
                "ImportPackageImmediately",
                System.Reflection.BindingFlags.Static |
                System.Reflection.BindingFlags.NonPublic |
                System.Reflection.BindingFlags.Public);

            if (immediate != null)
            {
                immediate.Invoke(null, new object[] { package });
            }
            else
            {
                Debug.LogWarning(
                    "[tmp] ImportPackageImmediately not found; falling back to the " +
                    "async import, which may not complete before the editor exits.");
                AssetDatabase.ImportPackage(package, false);
            }

            AssetDatabase.Refresh();

            if (IsImported) Debug.Log("[tmp] essential resources imported");
            else Debug.LogError("[tmp] import did not complete; TMP labels will render blank");
        }

        /// <summary>
        /// Locate the package inside the resolved ugui package.
        ///
        /// The path contains a content hash (com.unity.ugui@fd678869c0d5) that
        /// changes between resolutions, so it is searched for rather than
        /// hard-coded — a hard-coded path would break on someone else's checkout.
        /// </summary>
        private static string FindEssentialResources()
        {
            // The package may be resolved into the project's Library cache or, if
            // embedded, under Packages/. Check both.
            var roots = new[]
            {
                Path.GetFullPath("Library/PackageCache"),
                Path.GetFullPath("Packages"),
            };

            foreach (var root in roots)
            {
                if (!Directory.Exists(root)) continue;

                var match = Directory
                    .EnumerateFiles(root, "TMP Essential Resources.unitypackage",
                        SearchOption.AllDirectories)
                    .FirstOrDefault();

                if (match != null) return match;
            }
            return null;
        }
    }
}
