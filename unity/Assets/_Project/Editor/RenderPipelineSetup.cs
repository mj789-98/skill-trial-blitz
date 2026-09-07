using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Creates the URP pipeline assets and makes URP the ACTIVE pipeline.
    ///
    /// Installing the package is not enough, and the failure is quiet: with no
    /// Render Pipeline Asset assigned, Unity keeps using the Built-in pipeline,
    /// every URP shader fails to resolve, and the whole board renders magenta. It
    /// looks exactly like a missing material, which is what sent me looking in the
    /// wrong place first.
    ///
    /// Scripted rather than clicked so a clean checkout is a working checkout —
    /// the assets are committed, and this regenerates them if they are missing.
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath unity \
    ///     -executeMethod SkillApp.EditorTools.RenderPipelineSetup.Setup
    /// </summary>
    public static class RenderPipelineSetup
    {
        private const string Dir = "Assets/Settings";
        private const string RendererPath = Dir + "/MobileRenderer.asset";
        private const string PipelinePath = Dir + "/MobilePipeline.asset";

        [MenuItem("SkillApp/Setup URP")]
        public static void Setup()
        {
            Directory.CreateDirectory(Dir);

            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
            if (renderer == null)
            {
                renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
                AssetDatabase.CreateAsset(renderer, RendererPath);
                Debug.Log($"[urp] created {RendererPath}");
            }

            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                AssetDatabase.CreateAsset(pipeline, PipelinePath);
                Debug.Log($"[urp] created {PipelinePath}");
            }

            // Mobile-oriented defaults. This game is flat-shaded blocks under an
            // orthographic camera, so most of what URP can do is cost with no
            // visible benefit on the mid-range Android being targeted.
            pipeline.supportsHDR = false;          // LDR is plenty for flat colour
            pipeline.msaaSampleCount = 4;          // the one that IS worth it: the
                                                   // board is all long diagonal
                                                   // edges, which alias badly
            pipeline.shadowDistance = 25f;         // only the visible window needs it
            pipeline.shadowCascadeCount = 1;       // one camera, one shallow scene

            EditorUtility.SetDirty(pipeline);

            // BOTH matter. GraphicsSettings sets the default; QualitySettings can
            // override it per level, and a null override there silently falls back
            // to Built-in — which is the same magenta failure, just harder to find.
            GraphicsSettings.defaultRenderPipeline = pipeline;
            for (int i = 0; i < QualitySettings.count; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                QualitySettings.renderPipeline = pipeline;
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Debug.Log(
                $"[urp] active pipeline is now " +
                $"{(GraphicsSettings.currentRenderPipeline != null ? GraphicsSettings.currentRenderPipeline.name : "NULL — still Built-in")}");
        }
    }
}
